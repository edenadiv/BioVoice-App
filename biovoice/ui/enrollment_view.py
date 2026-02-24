"""Enrollment view: user ID input, waveform visualization, recording."""

import logging

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QThread, QTimer, Signal, Slot
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QVBoxLayout,
    QWidget,
)

from biovoice.ui.widgets import RecordingControls, WaveformWidget
from biovoice.utils.audio_io import MicrophoneRecorder
from biovoice.utils.constants import MAX_DURATION_SEC

logger = logging.getLogger(__name__)


class EnrollWorker(QThread):
    """Background thread for enrollment processing."""

    finished = Signal(bool, str)  # success, message

    def __init__(self, engine, user_id, waveform):
        super().__init__()
        self.engine = engine
        self.user_id = user_id
        self.waveform = waveform

    def run(self):
        try:
            self.engine.enroll(self.user_id, self.waveform)
            self.finished.emit(True, f"User '{self.user_id}' enrolled successfully.")
        except Exception as e:
            self.finished.emit(False, str(e))


class EnrollmentView(QWidget):
    """Enrollment screen: enter user ID, record voice, enroll."""

    enrollment_complete = Signal(str)  # user_id

    def __init__(self, engine, parent=None):
        super().__init__(parent)
        self.engine = engine
        self._recorder = MicrophoneRecorder(on_chunk=self._on_audio_chunk)
        self._audio_buffer = None
        self._worker = None
        self._timer = QTimer()
        self._timer.timeout.connect(self._update_timer)
        self._elapsed = 0.0

        self._build_ui()

    def _build_ui(self):
        layout = QVBoxLayout(self)
        layout.setSpacing(16)

        # Title
        title = QLabel("Speaker Enrollment")
        title.setObjectName("title")
        layout.addWidget(title)

        subtitle = QLabel("Record a voice sample to create a new speaker profile.")
        subtitle.setObjectName("subtitle")
        layout.addWidget(subtitle)

        # User ID card
        card = QFrame()
        card.setObjectName("card")
        card_layout = QVBoxLayout(card)

        id_label = QLabel("User ID")
        id_label.setObjectName("sectionHeader")
        card_layout.addWidget(id_label)

        id_row = QHBoxLayout()
        self.user_id_input = QLineEdit()
        self.user_id_input.setPlaceholderText("Enter a unique user identifier...")
        self.user_id_input.textChanged.connect(self._check_availability)
        id_row.addWidget(self.user_id_input)

        self.availability_label = QLabel("")
        id_row.addWidget(self.availability_label)
        card_layout.addLayout(id_row)

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

        # Timer
        self.timer_label = QLabel("0:00.0")
        self.timer_label.setObjectName("timerLabel")
        rec_layout.addWidget(self.timer_label)

        # Controls
        self.controls = RecordingControls()
        self.controls.record_clicked.connect(self._start_recording)
        self.controls.stop_clicked.connect(self._stop_recording)
        self.controls.play_clicked.connect(self._play_audio)
        rec_layout.addWidget(self.controls)

        layout.addWidget(rec_card)

        # Enroll button
        from PySide6.QtWidgets import QPushButton
        self.enroll_btn = QPushButton("ENROLL SPEAKER")
        self.enroll_btn.setObjectName("acceptButton")
        self.enroll_btn.setEnabled(False)
        self.enroll_btn.clicked.connect(self._do_enroll)
        layout.addWidget(self.enroll_btn)

        # Status
        self.status_label = QLabel("")
        layout.addWidget(self.status_label)

        layout.addStretch()

    def _check_availability(self, text: str):
        if not text.strip():
            self.availability_label.setText("")
            return
        if self.engine.store.exists(text.strip()):
            self.availability_label.setText("Already enrolled")
            self.availability_label.setObjectName("statusWarning")
        else:
            self.availability_label.setText("Available")
            self.availability_label.setObjectName("statusPass")
        self.availability_label.style().unpolish(self.availability_label)
        self.availability_label.style().polish(self.availability_label)
        self._update_enroll_enabled()

    def _start_recording(self):
        self.waveform.clear()
        self._elapsed = 0.0
        self.timer_label.setText("0:00.0")
        try:
            self._recorder.start()
            self.controls.set_recording(True)
            self._timer.start(100)
        except PermissionError as e:
            QMessageBox.critical(self, "Microphone Error", str(e))

    def _stop_recording(self):
        self._timer.stop()
        audio = self._recorder.stop()
        self.controls.set_recording(False)
        if len(audio) > 0:
            self._audio_buffer = audio
            self.controls.set_has_audio(True)
            self._update_enroll_enabled()

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

    def _update_enroll_enabled(self):
        has_id = bool(self.user_id_input.text().strip())
        has_audio = self._audio_buffer is not None
        self.enroll_btn.setEnabled(has_id and has_audio)

    def _do_enroll(self):
        user_id = self.user_id_input.text().strip()
        if not user_id:
            return

        self.enroll_btn.setEnabled(False)
        self.status_label.setText("Enrolling...")

        waveform = self.engine.audio.from_buffer(self._audio_buffer)
        self._worker = EnrollWorker(self.engine, user_id, waveform)
        self._worker.finished.connect(self._on_enroll_done)
        self._worker.start()

    @Slot(bool, str)
    def _on_enroll_done(self, success: bool, message: str):
        self.enroll_btn.setEnabled(True)
        if success:
            self.status_label.setText(message)
            self.status_label.setObjectName("statusPass")
            self.enrollment_complete.emit(self.user_id_input.text().strip())
            # Reset
            self.user_id_input.clear()
            self._audio_buffer = None
            self.controls.set_has_audio(False)
            self.waveform.clear()
        else:
            self.status_label.setText(f"Error: {message}")
            self.status_label.setObjectName("statusFail")
        self.status_label.style().unpolish(self.status_label)
        self.status_label.style().polish(self.status_label)
