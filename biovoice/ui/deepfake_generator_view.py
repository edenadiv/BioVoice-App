"""Testing tool: generate synthetic audio and run AASIST detection (SDD Figure 20)."""

import logging

import numpy as np
import sounddevice as sd
import torch
from PySide6.QtCore import QThread, Signal, Slot
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from biovoice.core.verification_engine import VerificationEngine
from biovoice.ui.widgets import RecordingControls, WaveformWidget
from biovoice.utils.audio_io import MicrophoneRecorder
from biovoice.utils.constants import MAX_DURATION_SEC, SAMPLE_RATE

logger = logging.getLogger(__name__)


class SyntheticGeneratorWorker(QThread):
    """Generate synthetic audio for deepfake testing."""

    finished = Signal(np.ndarray)  # generated audio

    def __init__(self, source_audio: np.ndarray, method: str):
        super().__init__()
        self.source_audio = source_audio
        self.method = method

    def run(self):
        """Generate synthetic audio using local-only signal processing transforms.

        Applies transformations that mimic common deepfake artifacts for testing.
        """
        audio = self.source_audio.copy()

        if self.method == "Pitch Shift":
            # Simple resampling-based pitch shift
            factor = 1.15
            indices = np.arange(0, len(audio), factor).astype(int)
            indices = indices[indices < len(audio)]
            audio = audio[indices]

        elif self.method == "Time Stretch":
            # Phase vocoder-style stretch (simplified)
            factor = 0.85
            indices = np.arange(0, len(audio), factor).astype(int)
            indices = indices[indices < len(audio)]
            audio = audio[indices]

        elif self.method == "Add Noise":
            noise = np.random.randn(len(audio)).astype(np.float32) * 0.02
            audio = audio + noise

        elif self.method == "Spectral Smoothing":
            # Apply aggressive smoothing (removes micro-details)
            from scipy.signal import savgol_filter
            if len(audio) > 51:
                audio = savgol_filter(audio, 51, 3).astype(np.float32)

        # Normalize
        peak = np.max(np.abs(audio))
        if peak > 0:
            audio = audio / peak

        self.finished.emit(audio)


class DeepfakeDetectWorker(QThread):
    """Run AASIST detection on audio."""

    finished = Signal(float)  # genuineness score

    def __init__(self, engine: VerificationEngine, audio: np.ndarray):
        super().__init__()
        self.engine = engine
        self.audio = audio

    def run(self):
        waveform = self.engine.audio.from_buffer(self.audio)
        score = self.engine.detector.detect(waveform)
        self.finished.emit(score)


class DeepfakeGeneratorView(QWidget):
    """Testing tool for deepfake generation and detection."""

    def __init__(self, engine: VerificationEngine, parent=None):
        super().__init__(parent)
        self.engine = engine
        self._recorder = MicrophoneRecorder(on_chunk=self._on_audio_chunk)
        self._source_audio = None
        self._synthetic_audio = None
        self._worker = None

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)

        title = QLabel("Deepfake Generator — Testing Tool")
        title.setObjectName("title")
        layout.addWidget(title)

        subtitle = QLabel(
            "Record source audio, apply transformations, and test AASIST detection."
        )
        subtitle.setObjectName("subtitle")
        layout.addWidget(subtitle)

        # Source audio card
        source_card = QFrame()
        source_card.setObjectName("card")
        source_layout = QVBoxLayout(source_card)

        source_label = QLabel("Source Audio")
        source_label.setObjectName("sectionHeader")
        source_layout.addWidget(source_label)

        self.source_waveform = WaveformWidget()
        source_layout.addWidget(self.source_waveform)

        self.source_controls = RecordingControls()
        self.source_controls.record_clicked.connect(self._start_source_recording)
        self.source_controls.stop_clicked.connect(self._stop_source_recording)
        self.source_controls.play_clicked.connect(self._play_source)
        source_layout.addWidget(self.source_controls)

        layout.addWidget(source_card)

        # Generation card
        gen_card = QFrame()
        gen_card.setObjectName("card")
        gen_layout = QVBoxLayout(gen_card)

        gen_label = QLabel("Synthesis Method")
        gen_label.setObjectName("sectionHeader")
        gen_layout.addWidget(gen_label)

        row = QHBoxLayout()
        self.method_combo = QComboBox()
        self.method_combo.addItems([
            "Pitch Shift", "Time Stretch", "Add Noise", "Spectral Smoothing"
        ])
        row.addWidget(self.method_combo)

        self.generate_btn = QPushButton("GENERATE")
        self.generate_btn.setEnabled(False)
        self.generate_btn.clicked.connect(self._generate)
        row.addWidget(self.generate_btn)

        gen_layout.addLayout(row)

        self.synth_waveform = WaveformWidget()
        gen_layout.addWidget(self.synth_waveform)

        synth_btns = QHBoxLayout()
        self.play_synth_btn = QPushButton("PLAY SYNTHETIC")
        self.play_synth_btn.setObjectName("playButton")
        self.play_synth_btn.setEnabled(False)
        self.play_synth_btn.clicked.connect(self._play_synthetic)
        synth_btns.addWidget(self.play_synth_btn)

        self.detect_btn = QPushButton("RUN AASIST DETECTION")
        self.detect_btn.setEnabled(False)
        self.detect_btn.clicked.connect(self._detect)
        synth_btns.addWidget(self.detect_btn)

        gen_layout.addLayout(synth_btns)

        layout.addWidget(gen_card)

        # Results
        self._result_label = QLabel("")
        self._result_label.setWordWrap(True)
        layout.addWidget(self._result_label)

        layout.addStretch()

    def _start_source_recording(self):
        self.source_waveform.clear()
        try:
            self._recorder.start()
            self.source_controls.set_recording(True)
        except PermissionError as e:
            from PySide6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Microphone Error", str(e))

    def _stop_source_recording(self):
        audio = self._recorder.stop()
        self.source_controls.set_recording(False)
        if len(audio) > 0:
            self._source_audio = audio
            self.source_controls.set_has_audio(True)
            self.generate_btn.setEnabled(True)

    def _play_source(self):
        if self._source_audio is not None:
            sd.play(self._source_audio, samplerate=SAMPLE_RATE)

    def _play_synthetic(self):
        if self._synthetic_audio is not None:
            sd.play(self._synthetic_audio, samplerate=SAMPLE_RATE)

    def _on_audio_chunk(self, chunk: np.ndarray):
        self.source_waveform.append_chunk(chunk)

    def _generate(self):
        if self._source_audio is None:
            return

        self.generate_btn.setEnabled(False)
        self._result_label.setText("Generating synthetic audio...")

        method = self.method_combo.currentText()
        self._worker = SyntheticGeneratorWorker(self._source_audio, method)
        self._worker.finished.connect(self._on_generated)
        self._worker.start()

    @Slot(np.ndarray)
    def _on_generated(self, audio: np.ndarray):
        self._synthetic_audio = audio
        self.generate_btn.setEnabled(True)
        self.play_synth_btn.setEnabled(True)
        self.detect_btn.setEnabled(True)

        # Show waveform
        self.synth_waveform.clear()
        chunk_size = 1000
        for i in range(0, len(audio), chunk_size):
            self.synth_waveform.append_chunk(audio[i:i + chunk_size])

        self._result_label.setText(
            f"Synthetic audio generated ({len(audio) / SAMPLE_RATE:.1f}s). "
            "Click 'Run AASIST Detection' to test."
        )

    def _detect(self):
        if self._synthetic_audio is None:
            return

        self.detect_btn.setEnabled(False)
        self._result_label.setText("Running AASIST detection...")

        self._worker = DeepfakeDetectWorker(self.engine, self._synthetic_audio)
        self._worker.finished.connect(self._on_detected)
        self._worker.start()

    @Slot(float)
    def _on_detected(self, score: float):
        self.detect_btn.setEnabled(True)
        is_genuine = self.engine.detector.is_genuine(score)
        if is_genuine:
            self._result_label.setText(
                f"AASIST RESULT: GENUINE (SCORE: {score:.3f})\n"
                "THE SYNTHETIC AUDIO WAS NOT DETECTED AS A DEEPFAKE."
            )
            self._result_label.setStyleSheet(
                "font-size: 14px; font-weight: 600; letter-spacing: 0.06em;"
                " color: #a8944e;"
            )
        else:
            self._result_label.setText(
                f"AASIST RESULT: DEEPFAKE DETECTED (SCORE: {score:.3f})\n"
                "THE SYNTHETIC AUDIO WAS SUCCESSFULLY FLAGGED."
            )
            self._result_label.setStyleSheet(
                "font-size: 14px; font-weight: 600; letter-spacing: 0.06em;"
                " color: #4ea882;"
            )
