from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote, urlsplit

import boto3
from aiortc import RTCIceServer
from botocore.credentials import ReadOnlyCredentials


@dataclass(frozen=True)
class KvsViewerContext:
    channel_arn: str
    https_endpoint: str
    wss_endpoint: str
    ice_servers: list[RTCIceServer]


def discover_viewer_context(
    session: boto3.Session,
    region: str,
    channel_name: str,
    client_id: str,
) -> KvsViewerContext:
    """Resolve the KVS signaling endpoints and temporary STUN/TURN credentials."""
    kvs = session.client("kinesisvideo", region_name=region)
    channel = kvs.describe_signaling_channel(ChannelName=channel_name)
    channel_arn = channel.get("ChannelInfo", {}).get("ChannelARN")
    if not channel_arn:
        raise RuntimeError(
            f"Signaling Channel '{channel_name}' のARNを取得できませんでした。"
        )

    endpoint_response = kvs.get_signaling_channel_endpoint(
        ChannelARN=channel_arn,
        SingleMasterChannelEndpointConfiguration={
            "Protocols": ["WSS", "HTTPS"],
            "Role": "VIEWER",
        },
    )
    endpoints = {
        item["Protocol"]: item["ResourceEndpoint"]
        for item in endpoint_response.get("ResourceEndpointList", [])
        if item.get("Protocol") and item.get("ResourceEndpoint")
    }
    if "WSS" not in endpoints or "HTTPS" not in endpoints:
        raise RuntimeError("VIEWER用のWSS/HTTPSエンドポイントを取得できませんでした。")

    signaling = session.client(
        "kinesis-video-signaling",
        region_name=region,
        endpoint_url=endpoints["HTTPS"],
    )
    ice_response = signaling.get_ice_server_config(
        ChannelARN=channel_arn,
        ClientId=client_id,
    )

    ice_servers = [
        RTCIceServer(urls=f"stun:stun.kinesisvideo.{region}.amazonaws.com:443")
    ]
    for server in ice_response.get("IceServerList", []):
        uris = server.get("Uris") or []
        if not uris:
            continue
        ice_servers.append(
            RTCIceServer(
                urls=uris,
                username=server.get("Username"),
                credential=server.get("Password"),
            )
        )

    return KvsViewerContext(
        channel_arn=channel_arn,
        https_endpoint=endpoints["HTTPS"],
        wss_endpoint=endpoints["WSS"],
        ice_servers=ice_servers,
    )


def frozen_credentials(session: boto3.Session) -> ReadOnlyCredentials:
    credentials = session.get_credentials()
    if credentials is None:
        raise RuntimeError(
            "AWS認証情報が見つかりません。AWS_PROFILE、AWS_*環境変数、または"
            "webapp/.env.localを確認してください。"
        )
    return credentials.get_frozen_credentials()


def create_presigned_wss_url(
    endpoint: str,
    channel_arn: str,
    client_id: str,
    region: str,
    credentials: ReadOnlyCredentials,
    now: datetime | None = None,
) -> str:
    """Create the SigV4 query-signed URL required by ConnectAsViewer."""
    parsed = urlsplit(endpoint)
    if parsed.scheme != "wss" or not parsed.netloc:
        raise ValueError(f"WSS endpointが不正です: {endpoint}")
    if parsed.query or parsed.fragment:
        raise ValueError("WSS endpointにはquery/fragmentを含めないでください。")

    instant = now or datetime.now(timezone.utc)
    instant = instant.astimezone(timezone.utc)
    datetime_string = instant.strftime("%Y%m%dT%H%M%SZ")
    date_string = instant.strftime("%Y%m%d")
    service = "kinesisvideo"
    credential_scope = f"{date_string}/{region}/{service}/aws4_request"

    query: dict[str, str] = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-ChannelARN": channel_arn,
        "X-Amz-ClientId": client_id,
        "X-Amz-Credential": f"{credentials.access_key}/{credential_scope}",
        "X-Amz-Date": datetime_string,
        "X-Amz-Expires": "299",
        "X-Amz-SignedHeaders": "host",
    }
    if credentials.token:
        query["X-Amz-Security-Token"] = credentials.token

    canonical_query = _canonical_query_string(query)
    canonical_uri = parsed.path or "/"
    canonical_headers = f"host:{parsed.netloc}\n"
    payload_hash = hashlib.sha256(b"").hexdigest()
    canonical_request = "\n".join(
        [
            "GET",
            canonical_uri,
            canonical_query,
            canonical_headers,
            "host",
            payload_hash,
        ]
    )
    canonical_request_hash = hashlib.sha256(
        canonical_request.encode("utf-8")
    ).hexdigest()
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            datetime_string,
            credential_scope,
            canonical_request_hash,
        ]
    )

    signing_key = _signature_key(credentials.secret_key, date_string, region, service)
    signature = hmac.new(
        signing_key,
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    query["X-Amz-Signature"] = signature
    return f"wss://{parsed.netloc}{canonical_uri}?{_canonical_query_string(query)}"


def encode_signaling_message(action: str, payload: dict[str, Any]) -> str:
    payload_json = json.dumps(payload, separators=(",", ":"), ensure_ascii=True)
    encoded_payload = base64.b64encode(payload_json.encode("utf-8")).decode("ascii")
    return json.dumps(
        {"action": action, "messagePayload": encoded_payload},
        separators=(",", ":"),
    )


def decode_signaling_message(raw_message: str | bytes) -> tuple[str, dict[str, Any]]:
    if isinstance(raw_message, bytes):
        raw_message = raw_message.decode("utf-8")
    if not raw_message.strip():
        # KVS signalingは空のapplication frameを返す場合があります。
        return "KEEPALIVE", {}
    envelope = json.loads(raw_message)
    message_type = envelope.get("messageType")
    if not message_type:
        raise ValueError("KVS signaling messageにmessageTypeがありません。")

    if message_type == "STATUS_RESPONSE":
        return message_type, envelope.get("statusResponse") or {}
    if message_type in {"GO_AWAY", "RECONNECT_ICE_SERVER"}:
        # サービス都合の切断通知にはJSONのmessagePayloadがない場合があります。
        return message_type, {}

    encoded_payload = envelope.get("messagePayload")
    if not encoded_payload:
        raise ValueError(f"{message_type}にmessagePayloadがありません。")
    decoded_payload = base64.b64decode(encoded_payload).decode("utf-8")
    if not decoded_payload.strip():
        raise ValueError(f"{message_type}のmessagePayloadが空です。")
    try:
        payload = json.loads(decoded_payload)
    except json.JSONDecodeError as error:
        raise ValueError(
            f"{message_type}のmessagePayloadがJSONではありません "
            f"(decoded_length={len(decoded_payload)})。"
        ) from error
    return message_type, payload


def _canonical_query_string(query: dict[str, str]) -> str:
    return "&".join(
        f"{quote(key, safe='-_.~')}={quote(str(query[key]), safe='-_.~')}"
        for key in sorted(query)
    )


def _signature_key(secret_key: str, date: str, region: str, service: str) -> bytes:
    key_date = hmac.new(
        f"AWS4{secret_key}".encode("utf-8"),
        date.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    key_region = hmac.new(key_date, region.encode("utf-8"), hashlib.sha256).digest()
    key_service = hmac.new(key_region, service.encode("utf-8"), hashlib.sha256).digest()
    return hmac.new(key_service, b"aws4_request", hashlib.sha256).digest()
