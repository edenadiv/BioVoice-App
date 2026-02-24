"""Multi-state results panel: processing, deepfake, verification, TCAV."""

import logging

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from biovoice.core.verification_engine import VerifyResult
from biovoice.ui.widgets import GaugeWidget
from biovoice.utils.constants import (
    DECISION_ACCEPT,
    DECISION_DEEPFAKE,
    DECISION_REJECT,
    DEEPFAKE_THRESHOLD,
    SIMILARITY_THRESHOLD,
)

logger = logging.getLogger(__name__)


class ResultsPanel(QWidget):
    """Displays verification results with multiple states."""

    def __init__(self, parent=None):
        super().__init__(parent)

        layout = QVBoxLayout(self)
        layout.setSpacing(16)

        title = QLabel("Results")
        title.setObjectName("title")
        layout.addWidget(title)

        self.stack = QStackedWidget()
        layout.addWidget(self.stack)

        # State 0: Empty / waiting
        self._empty_page = QLabel("Run a verification to see results here.")
        self._empty_page.setObjectName("subtitle")
        self._empty_page.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stack.addWidget(self._empty_page)

        # State 1: Processing
        self._processing_page = QLabel("Processing...")
        self._processing_page.setObjectName("subtitle")
        self._processing_page.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.stack.addWidget(self._processing_page)

        # State 2: Deepfake detected
        self._deepfake_page = self._build_deepfake_page()
        self.stack.addWidget(self._deepfake_page)

        # State 3: Verification result
        self._result_page = self._build_result_page()
        self.stack.addWidget(self._result_page)

        self.stack.setCurrentIndex(0)

    def _build_deepfake_page(self) -> QWidget:
        page = QFrame()
        page.setObjectName("resultWarning")
        layout = QVBoxLayout(page)

        icon = QLabel("\u26a0  DEEPFAKE DETECTED")
        icon.setObjectName("statusFail")
        icon.setAlignment(Qt.AlignmentFlag.AlignCenter)
        icon.setStyleSheet(
            "font-size: 18px; font-weight: 700; letter-spacing: 0.1em;"
        )
        layout.addWidget(icon)

        self._df_detail = QLabel("")
        self._df_detail.setObjectName("subtitle")
        self._df_detail.setStyleSheet("font-size: 12px; color: #7c8190;")
        self._df_detail.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self._df_detail)

        desc = QLabel(
            "The submitted audio sample has been flagged as synthetic or manipulated.\n"
            "Verification was not performed."
        )
        desc.setWordWrap(True)
        desc.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(desc)

        return page

    def _build_result_page(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)

        # Decision banner
        self._decision_frame = QFrame()
        self._decision_frame.setObjectName("resultPass")
        decision_layout = QVBoxLayout(self._decision_frame)

        self._decision_label = QLabel("")
        self._decision_label.setObjectName("statusPass")
        self._decision_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._decision_label.setStyleSheet(
            "font-size: 18px; font-weight: 700; letter-spacing: 0.1em;"
        )
        decision_layout.addWidget(self._decision_label)

        layout.addWidget(self._decision_frame)

        # Gauges row
        gauges = QHBoxLayout()

        self._sim_gauge = GaugeWidget()
        self._sim_gauge.set_label("Similarity")
        self._sim_gauge.set_threshold(SIMILARITY_THRESHOLD)
        gauges.addWidget(self._sim_gauge)

        self._df_gauge = GaugeWidget()
        self._df_gauge.set_label("Genuineness")
        self._df_gauge.set_threshold(DEEPFAKE_THRESHOLD)
        gauges.addWidget(self._df_gauge)

        layout.addLayout(gauges)

        # Detail text
        self._detail_label = QLabel("")
        self._detail_label.setWordWrap(True)
        self._detail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._detail_label.setStyleSheet("font-size: 12px; color: #7c8190;")
        layout.addWidget(self._detail_label)

        return page

    def show_empty(self):
        self.stack.setCurrentIndex(0)

    def show_processing(self):
        self.stack.setCurrentIndex(1)

    def show_result(self, result: VerifyResult):
        if result.decision == DECISION_DEEPFAKE:
            self._df_detail.setText(
                f"Genuineness score: {result.deepfake_score:.1%} "
                f"(threshold: {DEEPFAKE_THRESHOLD:.0%})"
            )
            self.stack.setCurrentIndex(2)
            return

        # Verification result
        if result.decision == DECISION_ACCEPT:
            self._decision_label.setText("IDENTITY VERIFIED")
            self._decision_label.setObjectName("statusPass")
            self._decision_frame.setObjectName("resultPass")
        else:
            self._decision_label.setText("IDENTITY REJECTED")
            self._decision_label.setObjectName("statusFail")
            self._decision_frame.setObjectName("resultFail")

        self._decision_label.style().unpolish(self._decision_label)
        self._decision_label.style().polish(self._decision_label)
        self._decision_frame.style().unpolish(self._decision_frame)
        self._decision_frame.style().polish(self._decision_frame)

        self._sim_gauge.set_score(result.similarity_score)
        self._df_gauge.set_score(result.deepfake_score)

        self._detail_label.setText(
            f"User: {result.user_id}\n"
            f"Similarity: {result.similarity_score:.1%} (threshold: {SIMILARITY_THRESHOLD:.0%})\n"
            f"Genuineness: {result.deepfake_score:.1%} (threshold: {DEEPFAKE_THRESHOLD:.0%})"
        )

        self.stack.setCurrentIndex(3)
