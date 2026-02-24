"""Record/Stop/Play button controls."""

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QHBoxLayout, QPushButton, QWidget


class RecordingControls(QWidget):
    """Record, stop, and play buttons for audio capture."""

    record_clicked = Signal()
    stop_clicked = Signal()
    play_clicked = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.record_btn = QPushButton("RECORD")
        self.record_btn.setObjectName("recordButton")
        self.record_btn.clicked.connect(self.record_clicked)

        self.stop_btn = QPushButton("STOP")
        self.stop_btn.setObjectName("stopButton")
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop_clicked)

        self.play_btn = QPushButton("PLAYBACK")
        self.play_btn.setObjectName("playButton")
        self.play_btn.setEnabled(False)
        self.play_btn.clicked.connect(self.play_clicked)

        layout.addWidget(self.record_btn)
        layout.addWidget(self.stop_btn)
        layout.addWidget(self.play_btn)

    def set_recording(self, recording: bool) -> None:
        """Update button states for recording mode."""
        self.record_btn.setEnabled(not recording)
        self.stop_btn.setEnabled(recording)
        self.play_btn.setEnabled(False)

    def set_has_audio(self, has_audio: bool) -> None:
        """Enable play button when audio is available."""
        self.play_btn.setEnabled(has_audio)
