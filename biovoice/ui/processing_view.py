"""Pipeline stage progress indicators."""

from PySide6.QtCore import Qt, Slot
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QProgressBar,
    QVBoxLayout,
    QWidget,
)


class PipelineStage(QFrame):
    """A single pipeline stage with label and progress bar."""

    def __init__(self, name: str, parent=None):
        super().__init__(parent)
        self.setObjectName("card")

        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 8, 12, 8)

        self._indicator = QLabel("  ")
        self._indicator.setFixedWidth(16)
        layout.addWidget(self._indicator)

        self._name = QLabel(name.upper())
        self._name.setMinimumWidth(180)
        self._name.setStyleSheet(
            "font-size: 12px; font-weight: 600; letter-spacing: 0.04em;"
        )
        layout.addWidget(self._name)

        self._progress = QProgressBar()
        self._progress.setRange(0, 100)
        self._progress.setValue(0)
        layout.addWidget(self._progress, 1)

        self._status = QLabel("PENDING")
        self._status.setFixedWidth(100)
        self._status.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._status.setStyleSheet(
            "font-size: 11px; letter-spacing: 0.06em;"
        )
        layout.addWidget(self._status)

    def set_pending(self):
        self._progress.setValue(0)
        self._status.setText("PENDING")
        self._status.setObjectName("")
        self._status.setStyleSheet(
            "font-size: 11px; letter-spacing: 0.06em; color: #555a66;"
        )
        self._indicator.setText("\u25cb")  # ○ hollow circle
        self._indicator.setStyleSheet("color: #363a45;")

    def set_running(self, progress: int = 50):
        self._progress.setValue(progress)
        self._status.setText("RUNNING")
        self._status.setObjectName("")
        self._status.setStyleSheet(
            "font-size: 11px; letter-spacing: 0.06em; color: #4e88a8;"
        )
        self._indicator.setText("\u25c9")  # ◉ fisheye
        self._indicator.setStyleSheet("color: #4e88a8;")

    def set_complete(self):
        self._progress.setValue(100)
        self._status.setText("COMPLETE")
        self._status.setObjectName("statusPass")
        self._status.setStyleSheet(
            "font-size: 11px; letter-spacing: 0.06em; color: #3d8b6e;"
        )
        self._indicator.setText("\u2713")  # ✓ check mark
        self._indicator.setStyleSheet("color: #3d8b6e;")

    def set_failed(self, reason: str = "FAILED"):
        self._progress.setValue(100)
        self._status.setText(reason.upper())
        self._status.setObjectName("statusFail")
        self._status.setStyleSheet(
            "font-size: 11px; letter-spacing: 0.06em; color: #8b3d3d;"
        )
        self._indicator.setText("\u2717")  # ✗ ballot X
        self._indicator.setStyleSheet("color: #8b3d3d;")


class ProcessingView(QWidget):
    """Pipeline stage progress display (SDD Figure 16)."""

    STAGES = [
        "Audio Preprocessing",
        "Deepfake Detection",
        "Speaker Embedding",
        "Similarity Comparison",
        "Decision",
    ]

    def __init__(self, parent=None):
        super().__init__(parent)

        layout = QVBoxLayout(self)
        layout.setSpacing(8)

        title = QLabel("Processing Pipeline")
        title.setObjectName("title")
        layout.addWidget(title)

        self._stages: list[PipelineStage] = []
        for name in self.STAGES:
            stage = PipelineStage(name)
            self._stages.append(stage)
            layout.addWidget(stage)

        layout.addStretch()

    def reset(self):
        for stage in self._stages:
            stage.set_pending()

    @Slot(int)
    def set_stage(self, index: int):
        """Mark stages up to index as complete, current as running."""
        for i, stage in enumerate(self._stages):
            if i < index:
                stage.set_complete()
            elif i == index:
                stage.set_running()
            else:
                stage.set_pending()

    def complete_all(self):
        for stage in self._stages:
            stage.set_complete()

    def fail_at(self, index: int, reason: str = "Failed"):
        for i, stage in enumerate(self._stages):
            if i < index:
                stage.set_complete()
            elif i == index:
                stage.set_failed(reason)
            else:
                stage.set_pending()
