"""Verification view: select enrolled user, record, verify/explain."""

import logging

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QThread, QTimer, Signal, Slot
from PySide6.QtWidgets import (
    QComboBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from biovoice.core.verification_engine import VerificationEngine, VerifyResult
from biovoice.core.tcav_analyzer import ExplanationResult
from biovoice.ui.widgets import RecordingControls, WaveformWidget
from biovoice.utils.audio_io import MicrophoneRecorder
from biovoice.utils.constants import MAX_DURATION_SEC

logger = logging.getLogger(__name__)


class VerifyWorker(QThread):
    """Background thread for verification."""

    finished = Signal(object)  # VerifyResult or Exception

    def __init__(self, engine, user_id, waveform):
        super().__init__()
        self.engine = engine
        self.user_id = user_id
        self.waveform = waveform

    def run(self):
        try:
            result = self.engine.verify(self.user_id, self.waveform)
            self.finished.emit(result)
        except Exception as e:
            self.finished.emit(e)


class ExplainWorker(QThread):
    """Background thread for TCAV explanation."""

    finished = Signal(object)  # ExplanationResult or Exception

    def __init__(self, engine, user_id, waveform):
        super().__init__()
        self.engine = engine
        self.user_id = user_id
        self.waveform = waveform

    def run(self):
        try:
            result = self.engine.explain(self.user_id, self.waveform)
            self.finished.emit(result)
        except Exception as e:
            self.finished.emit(e)


class VerificationView(QWidget):
    """Verification screen: select user, record, verify, explain."""

    verification_complete = Signal(object)  # VerifyResult
    explanation_ready = Signal(object)      # ExplanationResult

    def __init__(self, engine: VerificationEngine, parent=None):
        super().__init__(parent)
        self.engine = engine
        self._recorder = MicrophoneRecorder(on_chunk=self._on_audio_chunk)
        self._audio_buffer = None
        self._waveform_tensor = None
        self._worker = None
        self._timer = QTimer()
        self._timer.timeout.connect(self._update_timer)
        self._elapsed = 0.0

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)

        # Title
        title = QLabel("Speaker Verification")
        title.setObjectName("title")
        layout.addWidget(title)

        subtitle = QLabel("Verify a speaker against their enrolled voice profile.")
        subtitle.setObjectName("subtitle")
        layout.addWidget(subtitle)

        # User selection card
        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)

        sel_label = QLabel("Select Enrolled User")
        sel_label.setObjectName("sectionHeader")
        card_layout.addWidget(sel_label)

        self.user_combo = QComboBox()
        self.user_combo.setPlaceholderText("Choose a user...")
        card_layout.addWidget(self.user_combo)

        layout.addWidget(card)

        # Recording card
        rec_card = QFrame()
        rec_card.setObjectName("card")
        rec_layout = QVBoxLayout(rec_card)

        rec_label = QLabel("Voice Sample")
        rec_label.setObjectName("sectionHeader")
        rec_layout.addWidget(rec_label)

        self.waveform = WaveformWidget()
        rec_layout.addWidget(self.waveform)

        self.timer_label = QLabel("0:00.0")
        self.timer_label.setObjectName("timerLabel")
        rec_layout.addWidget(self.timer_label)

        self.controls = RecordingControls()
        self.controls.record_clicked.connect(self._start_recording)
        self.controls.stop_clicked.connect(self._stop_recording)
        self.controls.play_clicked.connect(self._play_audio)
        rec_layout.addWidget(self.controls)

        layout.addWidget(rec_card)

        # Action buttons
        btn_row = QHBoxLayout()

        self.verify_btn = QPushButton("VERIFY SPEAKER")
        self.verify_btn.setObjectName("acceptButton")
        self.verify_btn.setEnabled(False)
        self.verify_btn.clicked.connect(self._do_verify)
        btn_row.addWidget(self.verify_btn)

        self.explain_btn = QPushButton("EXPLAIN DECISION")
        self.explain_btn.setEnabled(False)
        self.explain_btn.clicked.connect(self._do_explain)
        btn_row.addWidget(self.explain_btn)

        layout.addLayout(btn_row)

        # Status
        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

        layout.addStretch()

    def refresh_users(self):
        """Reload the user list from the profile store."""
        self.user_combo.clear()
        users = self.engine.store.list_all()
        self.user_combo.addItems(users)
        self._update_buttons()

    def _start_recording(self):
        self.waveform.clear()
        self._elapsed = 0.0
        self.timer_label.setText("0:00.0")
        try:
            self._recorder.start()
            self.controls.set_recording(True)
            self._timer.start(100)
        except PermissionError as e:
            from PySide6.QtWidgets import QMessageBox
            QMessageBox.critical(self, "Microphone Error", str(e))

    def _stop_recording(self):
        self._timer.stop()
        audio = self._recorder.stop()
        self.controls.set_recording(False)
        if len(audio) > 0:
            self._audio_buffer = audio
            self._waveform_tensor = self.engine.audio.from_buffer(audio)
            self.controls.set_has_audio(True)
            self._update_buttons()

    def _play_audio(self):
        if self._audio_buffer is not None:
            sd.play(self._audio_buffer, samplerate=16000)

    def _on_audio_chunk(self, chunk: np.ndarray):
        self.waveform.append_chunk(chunk)

    def _update_timer(self):
        self._elapsed = self._recorder.get_elapsed_seconds()
        mins = int(self._elapsed) // 60
        secs = self._elapsed % 60
        self.timer_label.setText(f"{mins}:{secs:04.1f}")
        if self._elapsed >= MAX_DURATION_SEC:
            self._stop_recording()

    def _update_buttons(self):
        has_user = self.user_combo.currentText() != ""
        has_audio = self._audio_buffer is not None
        self.verify_btn.setEnabled(has_user and has_audio)
        self.explain_btn.setEnabled(has_user and has_audio)

    def _do_verify(self):
        user_id = self.user_combo.currentText()
        if not user_id or self._waveform_tensor is None:
            return

        self.verify_btn.setEnabled(False)
        self.explain_btn.setEnabled(False)
        self.status_label.setText("Verifying...")

        self._worker = VerifyWorker(self.engine, user_id, self._waveform_tensor)
        self._worker.finished.connect(self._on_verify_done)
        self._worker.start()

    @Slot(object)
    def _on_verify_done(self, result):
        self._update_buttons()
        if isinstance(result, Exception):
            self.status_label.setText(f"Error: {result}")
            self.status_label.setObjectName("statusFail")
        else:
            self.status_label.setText(
                f"Decision: {result.decision} | "
                f"Similarity: {result.similarity_score:.1%} | "
                f"Genuineness: {result.deepfake_score:.1%}"
            )
            obj_name = "statusPass" if result.decision == "ACCEPT" else "statusFail"
            self.status_label.setObjectName(obj_name)
            self.verification_complete.emit(result)
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)

    def _do_explain(self):
        user_id = self.user_combo.currentText()
        if not user_id or self._waveform_tensor is None:
            return

        self.explain_btn.setEnabled(False)
        self.status_label.setText("Generating explanation...")

        self._worker = ExplainWorker(self.engine, user_id, self._waveform_tensor)
        self._worker.finished.connect(self._on_explain_done)
        self._worker.start()

    @Slot(object)
    def _on_explain_done(self, result):
        self._update_buttons()
        if isinstance(result, Exception):
            self.status_label.setText(f"Error: {result}")
        else:
            self.status_label.setText(result.summary)
            self.explanation_ready.emit(result)
