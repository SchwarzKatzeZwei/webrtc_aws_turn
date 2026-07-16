from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import os
import queue
import signal
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import av
import boto3
import cv2
import numpy as np
from aiortc import (
    RTCBundlePolicy,
    RTCConfiguration,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.mediastreams import MediaStreamError, MediaStreamTrack
from aiortc.sdp import candidate_from_sdp
from dotenv import load_dotenv
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from kvs_signaling import (
    KvsViewerContext,
    create_presigned_wss_url,
    decode_signaling_message,
    discover_viewer_context,
    encode_signaling_message,
    frozen_credentials,
)


LOGGER = logging.getLogger("kvs-python-viewer")
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ENV_FILE = PROJECT_ROOT / "webapp" / ".env.local"

CONTROL_CHANNEL_LABEL = "kvs-link-control-v1"
CONTROL_DISCONNECT = "receiver-disconnect"
CONTROL_DISCONNECT_ACK = "receiver-disconnect-ack"


class AudioOutput:
    """Write decoded PCM to PortAudio without blocking asyncio's media loop."""

    def __init__(self, sample_rate: int = 48_000, channels: int = 2) -> None:
        import sounddevice as sd

        self._sd = sd
        self._sample_rate = sample_rate
        self._channels = channels
        self._queue: queue.Queue[bytes | None] = queue.Queue(maxsize=12)
        self._stream: Any = None
        self._thread: threading.Thread | None = None
        self._closed = False

    def start(self) -> None:
        self._stream = self._sd.RawOutputStream(
            samplerate=self._sample_rate,
            channels=self._channels,
            dtype="int16",
            latency="low",
        )
        self._stream.start()
        self._thread = threading.Thread(
            target=self._write_loop,
            name="webrtc-audio-output",
            daemon=True,
        )
        self._thread.start()

    def enqueue(self, pcm: bytes) -> None:
        if self._closed:
            return
        try:
            self._queue.put_nowait(pcm)
        except queue.Full:
            # 音声遅延が増え続けないよう、最古のブロックを捨てます。
            with contextlib.suppress(queue.Empty):
                self._queue.get_nowait()
            with contextlib.suppress(queue.Full):
                self._queue.put_nowait(pcm)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        while True:
            try:
                self._queue.put_nowait(None)
                break
            except queue.Full:
                with contextlib.suppress(queue.Empty):
                    self._queue.get_nowait()
        if self._thread:
            self._thread.join(timeout=2)
        if self._stream is not None:
            with contextlib.suppress(Exception):
                self._stream.abort()
            with contextlib.suppress(Exception):
                self._stream.close()
        self._stream = None

    def _write_loop(self) -> None:
        try:
            while True:
                pcm = self._queue.get()
                if pcm is None:
                    return
                self._stream.write(pcm)
        except Exception as error:
            LOGGER.error("音声出力が停止しました: %s", error)


class KvsWebRtcReceiver:
    def __init__(
        self,
        session: boto3.Session,
        region: str,
        channel_name: str,
        client_id: str,
        play_audio: bool,
        window_name: str,
    ) -> None:
        self._session = session
        self._region = region
        self._channel_name = channel_name
        self._client_id = client_id
        self._play_audio = play_audio
        self._window_name = window_name
        self._stop_event = asyncio.Event()
        self._disconnect_ack = asyncio.Event()
        self._peer: RTCPeerConnection | None = None
        self._control_channel: Any = None
        self._audio_output: AudioOutput | None = None
        self._media_tasks: set[asyncio.Task[None]] = set()
        self._pending_ice: list[dict[str, Any]] = []

    def request_stop(self) -> None:
        self._stop_event.set()

    async def run(self) -> None:
        LOGGER.info("KVS設定とTURN認証情報を取得しています")
        context = await asyncio.to_thread(
            discover_viewer_context,
            self._session,
            self._region,
            self._channel_name,
            self._client_id,
        )
        credentials = frozen_credentials(self._session)
        signed_url = create_presigned_wss_url(
            endpoint=context.wss_endpoint,
            channel_arn=context.channel_arn,
            client_id=self._client_id,
            region=self._region,
            credentials=credentials,
        )

        self._create_peer(context)
        LOGGER.info("VIEWER ID: %s", self._client_id)
        LOGGER.info("KVS signalingへ接続しています")

        try:
            async with connect(
                signed_url,
                open_timeout=15,
                close_timeout=3,
                ping_interval=20,
                ping_timeout=20,
                max_size=64 * 1024,
            ) as websocket:
                await self._send_offer(websocket)
                await self._receive_signaling(websocket)
        except ConnectionClosed as error:
            if not self._stop_event.is_set():
                LOGGER.warning("KVS signaling接続が終了しました: %s", error)
        finally:
            await self._shutdown_peer()

    def _create_peer(self, context: KvsViewerContext) -> None:
        configuration = RTCConfiguration(
            iceServers=context.ice_servers,
            bundlePolicy=RTCBundlePolicy.MAX_BUNDLE,
        )
        peer = RTCPeerConnection(configuration)
        self._peer = peer

        # 音声を再生しない場合も受信して破棄し、ブラウザMASTERとのSDPを揃えます。
        peer.addTransceiver("video", direction="recvonly")
        peer.addTransceiver("audio", direction="recvonly")

        control = peer.createDataChannel(CONTROL_CHANNEL_LABEL, ordered=True)
        self._control_channel = control

        @control.on("open")
        def on_control_open() -> None:
            LOGGER.debug("制御DataChannelが開きました")

        @control.on("message")
        def on_control_message(message: str | bytes) -> None:
            if message == CONTROL_DISCONNECT_ACK:
                self._disconnect_ack.set()

        @peer.on("connectionstatechange")
        async def on_connectionstatechange() -> None:
            LOGGER.info(
                "WebRTC connection=%s ice=%s",
                peer.connectionState,
                peer.iceConnectionState,
            )
            if peer.connectionState == "connected":
                LOGGER.info("MASTERとのWebRTC接続が確立しました")
            elif peer.connectionState in {"failed", "closed"}:
                self._stop_event.set()

        @peer.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            LOGGER.info("%sトラックを受信しました", track.kind)
            if track.kind == "video":
                self._start_media_task(self._consume_video(track), "video-receiver")
            elif track.kind == "audio":
                self._start_media_task(self._consume_audio(track), "audio-receiver")

    def _start_media_task(self, coroutine: Any, name: str) -> None:
        task = asyncio.create_task(coroutine, name=name)
        self._media_tasks.add(task)
        task.add_done_callback(self._media_task_done)

    def _media_task_done(self, task: asyncio.Task[None]) -> None:
        self._media_tasks.discard(task)
        if task.cancelled():
            return
        error = task.exception()
        if error:
            LOGGER.error("メディア処理に失敗しました: %s", error)
            self._stop_event.set()

    async def _send_offer(self, websocket: ClientConnection) -> None:
        if self._peer is None:
            raise RuntimeError("RTCPeerConnectionが初期化されていません。")
        LOGGER.info("ICE candidateを収集し、SDP Offerを作成しています")
        offer = await self._peer.createOffer()
        await self._peer.setLocalDescription(offer)
        local_description = self._peer.localDescription
        if local_description is None:
            raise RuntimeError("ローカルSDP Offerを作成できませんでした。")
        await websocket.send(
            encode_signaling_message(
                "SDP_OFFER",
                {"type": local_description.type, "sdp": local_description.sdp},
            )
        )
        LOGGER.info("SDP Offerを送信しました。MASTERの応答を待っています")

    async def _receive_signaling(self, websocket: ClientConnection) -> None:
        stop_task = asyncio.create_task(self._stop_event.wait(), name="stop-waiter")
        try:
            while not self._stop_event.is_set():
                receive_task = asyncio.create_task(
                    websocket.recv(), name="kvs-signaling-recv"
                )
                done, _ = await asyncio.wait(
                    {receive_task, stop_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_task in done:
                    receive_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await receive_task
                    return

                raw_message = receive_task.result()
                try:
                    message_type, payload = decode_signaling_message(raw_message)
                    await self._handle_signaling_message(message_type, payload)
                except (ValueError, KeyError) as error:
                    LOGGER.warning(
                        "KVS signaling messageを処理できませんでした: %s", error
                    )
        finally:
            stop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await stop_task

    async def _handle_signaling_message(
        self,
        message_type: str,
        payload: dict[str, Any],
    ) -> None:
        if self._peer is None:
            return
        if message_type == "SDP_ANSWER":
            await self._peer.setRemoteDescription(
                RTCSessionDescription(sdp=payload["sdp"], type=payload["type"])
            )
            LOGGER.info("MASTERのSDP Answerを適用しました")
            pending, self._pending_ice = self._pending_ice, []
            for candidate_payload in pending:
                await self._add_remote_ice(candidate_payload)
        elif message_type == "ICE_CANDIDATE":
            if self._peer.remoteDescription is None:
                self._pending_ice.append(payload)
            else:
                await self._add_remote_ice(payload)
        elif message_type == "STATUS_RESPONSE":
            status_code = payload.get("statusCode")
            description = (
                payload.get("description") or payload.get("errorType") or "詳細不明"
            )
            if status_code is not None and str(status_code) != "200":
                raise RuntimeError(f"KVS signaling error {status_code}: {description}")
            LOGGER.debug("KVS status response: %s", payload)
        elif message_type == "GO_AWAY":
            LOGGER.warning("KVSからGO_AWAYを受信しました。接続を終了します")
            self._stop_event.set()
        elif message_type == "RECONNECT_ICE_SERVER":
            LOGGER.warning(
                "KVSからTURN再接続要求を受信しました。新しいTURN認証情報を取得するため終了します"
            )
            self._stop_event.set()
        elif message_type == "KEEPALIVE":
            LOGGER.debug("KVS signaling keepaliveを受信しました")

    async def _add_remote_ice(self, payload: dict[str, Any]) -> None:
        if self._peer is None:
            return
        candidate_sdp = payload.get("candidate")
        if not candidate_sdp:
            return
        if candidate_sdp.startswith("candidate:"):
            candidate_sdp = candidate_sdp[len("candidate:") :]
        candidate = candidate_from_sdp(candidate_sdp)
        candidate.sdpMid = payload.get("sdpMid")
        candidate.sdpMLineIndex = payload.get("sdpMLineIndex")
        await self._peer.addIceCandidate(candidate)

    async def _consume_video(self, track: MediaStreamTrack) -> None:
        frame_count = 0
        report_started = time.monotonic()
        try:
            while not self._stop_event.is_set():
                frame = await track.recv()
                image: np.ndarray = frame.to_ndarray(format="bgr24")
                frame_count += 1

                elapsed = time.monotonic() - report_started
                if elapsed >= 2:
                    LOGGER.info(
                        "映像 %dx%d / %.1f fps / numpy=%s %s",
                        image.shape[1],
                        image.shape[0],
                        frame_count / elapsed,
                        image.shape,
                        image.dtype,
                    )
                    frame_count = 0
                    report_started = time.monotonic()

                cv2.imshow(self._window_name, image)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    self._stop_event.set()
                    return
        except MediaStreamError:
            LOGGER.info("映像トラックが終了しました")
            self._stop_event.set()

    async def _consume_audio(self, track: MediaStreamTrack) -> None:
        if not self._play_audio:
            LOGGER.info("音声再生は無効です。音声フレームを受信して破棄します")
            await self._discard_track(track)
            return

        try:
            output = AudioOutput()
            output.start()
            self._audio_output = output
            LOGGER.info("音声出力を開始しました (48 kHz / stereo / int16)")
        except Exception as error:
            LOGGER.warning("音声デバイスを開始できません。音声を破棄します: %s", error)
            await self._discard_track(track)
            return

        resampler = av.AudioResampler(format="s16", layout="stereo", rate=48_000)
        try:
            while not self._stop_event.is_set():
                frame = await track.recv()
                for resampled in resampler.resample(frame):
                    pcm = (
                        np.ascontiguousarray(resampled.to_ndarray())
                        .reshape(-1)
                        .tobytes()
                    )
                    output.enqueue(pcm)
        except MediaStreamError:
            LOGGER.info("音声トラックが終了しました")

    async def _discard_track(self, track: MediaStreamTrack) -> None:
        try:
            while not self._stop_event.is_set():
                await track.recv()
        except MediaStreamError:
            return

    async def _shutdown_peer(self) -> None:
        channel = self._control_channel
        if channel is not None and channel.readyState == "open":
            with contextlib.suppress(Exception):
                channel.send(CONTROL_DISCONNECT)
                await asyncio.wait_for(self._disconnect_ack.wait(), timeout=0.5)

        for task in tuple(self._media_tasks):
            task.cancel()
        if self._media_tasks:
            await asyncio.gather(*self._media_tasks, return_exceptions=True)
        self._media_tasks.clear()

        if self._audio_output is not None:
            await asyncio.to_thread(self._audio_output.close)
            self._audio_output = None
        cv2.destroyAllWindows()

        if self._peer is not None:
            await self._peer.close()
            self._peer = None
        LOGGER.info("受信を終了しました")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="AWS KVS WebRTCをVIEWERとして受信し、NumPy/OpenCVで表示します。"
    )
    parser.add_argument("--channel-name", help="KVS Signaling Channel名")
    parser.add_argument("--region", help="AWS Region（例: ap-northeast-1）")
    parser.add_argument("--profile", help="使用するAWS CLI profile")
    parser.add_argument("--client-id", help="KVS VIEWER ClientId")
    parser.add_argument(
        "--env-file",
        type=Path,
        default=DEFAULT_ENV_FILE,
        help=f"VITE_AWS_*を読み込むenvファイル（既定: {DEFAULT_ENV_FILE}）",
    )
    parser.add_argument("--no-audio", action="store_true", help="受信音声を再生しない")
    parser.add_argument("--window-name", default="KVS WebRTC Python Viewer")
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args()


def create_session(args: argparse.Namespace) -> tuple[boto3.Session, str, str]:
    if args.env_file.exists():
        load_dotenv(args.env_file, override=False)

    requested_region = (
        args.region
        or os.getenv("VITE_AWS_REGION")
        or os.getenv("AWS_REGION")
        or os.getenv("AWS_DEFAULT_REGION")
    )
    channel_name = args.channel_name or os.getenv("VITE_KVS_CHANNEL_NAME")

    if args.profile:
        session = boto3.Session(profile_name=args.profile, region_name=requested_region)
    elif os.getenv("VITE_AWS_ACCESS_KEY_ID") and os.getenv(
        "VITE_AWS_SECRET_ACCESS_KEY"
    ):
        session = boto3.Session(
            aws_access_key_id=os.environ["VITE_AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["VITE_AWS_SECRET_ACCESS_KEY"],
            aws_session_token=os.getenv("VITE_AWS_SESSION_TOKEN") or None,
            region_name=requested_region,
        )
    else:
        session = boto3.Session(region_name=requested_region)

    region = requested_region or session.region_name
    if not region:
        raise RuntimeError("AWS Regionを--regionまたは環境変数で指定してください。")
    if not channel_name:
        raise RuntimeError(
            "Signaling Channel名を--channel-nameまたはVITE_KVS_CHANNEL_NAMEで指定してください。"
        )
    return session, region, channel_name


async def async_main(args: argparse.Namespace) -> None:
    session, region, channel_name = create_session(args)
    client_id = args.client_id or f"python-viewer-{uuid.uuid4().hex[:16]}"
    receiver = KvsWebRtcReceiver(
        session=session,
        region=region,
        channel_name=channel_name,
        client_id=client_id,
        play_audio=not args.no_audio,
        window_name=args.window_name,
    )

    loop = asyncio.get_running_loop()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):
            loop.add_signal_handler(signal_name, receiver.request_stop)
    await receiver.run()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        asyncio.run(async_main(args))
    except KeyboardInterrupt:
        pass
    except Exception as error:
        LOGGER.error("受信に失敗しました: %s", error)
        if args.debug:
            raise
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
