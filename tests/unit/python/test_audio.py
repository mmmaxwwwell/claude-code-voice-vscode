"""Unit tests for sidecar.audio — AudioInputStream."""

from unittest.mock import MagicMock, patch
import pytest

np = pytest.importorskip("numpy", exc_type=ImportError)

from sidecar.audio import AudioInputStream, SAMPLE_RATE, FRAME_DURATION_MS, FRAME_SAMPLES
from sidecar.errors import AudioError


class TestAudioInputStreamConfig:
    """Test AudioInputStream configuration."""

    def test_default_device_is_none(self):
        stream = AudioInputStream()
        assert stream.device is None

    def test_custom_device(self):
        stream = AudioInputStream(device="hw:1,0")
        assert stream.device == "hw:1,0"

    def test_empty_string_device_becomes_none(self):
        stream = AudioInputStream(device="")
        assert stream.device is None

    def test_sample_rate(self):
        stream = AudioInputStream()
        assert stream.sample_rate == SAMPLE_RATE

    def test_frame_duration_ms(self):
        stream = AudioInputStream()
        assert stream.frame_duration_ms == FRAME_DURATION_MS

    def test_frame_samples_is_480(self):
        """16kHz × 30ms = 480 samples per frame."""
        stream = AudioInputStream()
        assert stream.frame_samples == 480
        assert stream.frame_samples == FRAME_SAMPLES


class TestAudioInputStreamMic:
    """Test microphone-based streaming via mocked sounddevice."""

    def _make_mock_sd(self, frames_to_deliver=None):
        """Create a mock sounddevice module with a working InputStream context manager.

        The mock InputStream captures the callback kwarg and calls it with
        the provided frames, then signals stop.
        """
        mock_sd = MagicMock()

        delivered_frames = frames_to_deliver or []

        class FakeInputStream:
            def __init__(self, **kwargs):
                self.callback = kwargs.get("callback")
                self.kwargs = kwargs

            def __enter__(self):
                # Deliver frames via the callback, then signal stop
                for frame_data in delivered_frames:
                    if self.callback:
                        self.callback(frame_data, len(frame_data), None, None)
                return self

            def __exit__(self, *args):
                return False

        mock_sd.InputStream = FakeInputStream
        return mock_sd

    @patch("sidecar.audio._import_sounddevice")
    def test_yields_frames_from_mic(self, mock_import):
        """Frames from mic callback should be yielded by frames()."""
        fake_audio = np.ones((FRAME_SAMPLES, 1), dtype=np.int16) * 42
        mock_sd = self._make_mock_sd(frames_to_deliver=[fake_audio])
        mock_import.return_value = mock_sd

        stream = AudioInputStream()
        # After the context manager delivers frames and exits,
        # the queue has frames + we need to signal stop
        # The FakeInputStream.__enter__ fires callbacks synchronously,
        # then __exit__ runs. But the while loop in _frames_from_mic
        # will block on queue.get(). We need to also enqueue a stop sentinel.

        # Actually: the callback fires during __enter__, putting frames on queue.
        # Then the while loop starts reading. After reading the frame,
        # it blocks on queue.get() again. We need to stop it.

        # Simplest: deliver frames, then have stop called.
        # Let's override to also put None sentinel after frames.
        class FakeInputStream:
            def __init__(self, **kwargs):
                self.callback = kwargs.get("callback")
                self.kwargs = kwargs

            def __enter__(self):
                if self.callback:
                    self.callback(fake_audio, FRAME_SAMPLES, None, None)
                # Put stop sentinel
                stream._queue.put(None)
                return self

            def __exit__(self, *args):
                return False

        mock_sd.InputStream = FakeInputStream

        frames = list(stream.frames())
        assert len(frames) == 1
        assert frames[0].shape == (FRAME_SAMPLES,)
        assert frames[0].dtype == np.int16
        assert frames[0][0] == 42

    @patch("sidecar.audio._import_sounddevice")
    def test_sample_rate_passed_to_sounddevice(self, mock_import):
        """InputStream must be opened at 16kHz mono int16."""
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_ctx)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_sd.InputStream.return_value = mock_ctx

        stream = AudioInputStream()
        # Put stop sentinel so the loop exits immediately
        stream._queue.put(None)

        list(stream.frames())

        mock_sd.InputStream.assert_called_once()
        kwargs = mock_sd.InputStream.call_args[1]
        assert kwargs["samplerate"] == SAMPLE_RATE
        assert kwargs["channels"] == 1
        assert kwargs["dtype"] == "int16"
        assert kwargs["blocksize"] == FRAME_SAMPLES

    @patch("sidecar.audio._import_sounddevice")
    def test_custom_device_passed_to_sounddevice(self, mock_import):
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_ctx)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_sd.InputStream.return_value = mock_ctx

        stream = AudioInputStream(device="hw:1,0")
        stream._queue.put(None)
        list(stream.frames())

        kwargs = mock_sd.InputStream.call_args[1]
        assert kwargs["device"] == "hw:1,0"

    @patch("sidecar.audio._import_sounddevice")
    def test_none_device_passed_when_default(self, mock_import):
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_ctx)
        mock_ctx.__exit__ = MagicMock(return_value=False)
        mock_sd.InputStream.return_value = mock_ctx

        stream = AudioInputStream()
        stream._queue.put(None)
        list(stream.frames())

        kwargs = mock_sd.InputStream.call_args[1]
        assert kwargs["device"] is None


class TestAudioInputStreamErrors:
    """Test error handling for mic issues."""

    @patch("sidecar.audio._import_sounddevice")
    def test_no_mic_raises_audio_error(self, mock_import):
        """Missing mic should raise AudioError with MIC_NOT_FOUND."""
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        # PortAudioError needs to be a real exception class on the mock
        class FakePortAudioError(Exception):
            pass

        mock_sd.PortAudioError = FakePortAudioError
        mock_sd.InputStream.side_effect = FakePortAudioError("No device")

        stream = AudioInputStream()
        with pytest.raises(AudioError) as exc_info:
            list(stream.frames())

        assert exc_info.value.code == "MIC_NOT_FOUND"

    @patch("sidecar.audio._import_sounddevice")
    def test_permission_denied_raises_audio_error(self, mock_import):
        """Permission denied should raise AudioError with MIC_PERMISSION_DENIED."""
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        class FakePortAudioError(Exception):
            pass

        mock_sd.PortAudioError = FakePortAudioError
        mock_sd.InputStream.side_effect = OSError("[Errno 13] Permission denied")

        stream = AudioInputStream()
        with pytest.raises(AudioError) as exc_info:
            list(stream.frames())

        assert exc_info.value.code == "MIC_PERMISSION_DENIED"

    @patch("sidecar.audio._import_sounddevice")
    def test_generic_error_raises_audio_device_error(self, mock_import):
        """Other errors should raise AudioError with AUDIO_DEVICE_ERROR."""
        mock_sd = MagicMock()
        mock_import.return_value = mock_sd

        class FakePortAudioError(Exception):
            pass

        mock_sd.PortAudioError = FakePortAudioError
        mock_sd.InputStream.side_effect = RuntimeError("Something went wrong")

        stream = AudioInputStream()
        with pytest.raises(AudioError) as exc_info:
            list(stream.frames())

        assert exc_info.value.code == "AUDIO_DEVICE_ERROR"


class TestAudioInputStreamFileSource:
    """Test file-based audio source for testing."""

    def test_file_source_yields_frames(self):
        """When given a file source, read from it instead of mic."""
        audio_data = np.zeros(FRAME_SAMPLES * 2, dtype=np.int16)
        audio_data[:FRAME_SAMPLES] = 100
        audio_data[FRAME_SAMPLES:] = 200

        stream = AudioInputStream(file_source=audio_data)
        frames = list(stream.frames())

        assert len(frames) == 2
        assert frames[0][0] == 100
        assert frames[1][0] == 200
        assert all(f.shape == (FRAME_SAMPLES,) for f in frames)
        assert all(f.dtype == np.int16 for f in frames)

    def test_file_source_pads_last_frame(self):
        """Partial last frame should be zero-padded."""
        audio_data = np.ones(FRAME_SAMPLES + FRAME_SAMPLES // 2, dtype=np.int16)

        stream = AudioInputStream(file_source=audio_data)
        frames = list(stream.frames())

        assert len(frames) == 2
        assert frames[1][-1] == 0

    def test_file_source_exact_frames(self):
        """Exact multiple of frame size should not produce extra frames."""
        audio_data = np.ones(FRAME_SAMPLES * 3, dtype=np.int16) * 500

        stream = AudioInputStream(file_source=audio_data)
        frames = list(stream.frames())

        assert len(frames) == 3
        assert all(f.shape == (FRAME_SAMPLES,) for f in frames)

    def test_file_source_frame_size_is_480(self):
        """Each frame should be exactly 480 samples (16kHz × 30ms)."""
        audio_data = np.zeros(FRAME_SAMPLES * 5, dtype=np.int16)

        stream = AudioInputStream(file_source=audio_data)
        frames = list(stream.frames())

        assert len(frames) == 5
        for frame in frames:
            assert len(frame) == 480
