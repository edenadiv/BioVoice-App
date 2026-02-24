"""Horizontal bar chart widget for TCAV concept scores."""

from PySide6.QtCore import QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QFont, QLinearGradient, QPainter, QPen
from PySide6.QtWidgets import QWidget


class ConceptBar(QWidget):
    """Displays a single TCAV concept as a horizontal bar."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._concept = ""
        self._score = 0.5
        self._sign = "positive"
        self.setFixedHeight(32)
        self.setMinimumWidth(300)

    def set_data(self, concept: str, score: float, sign: str = "positive") -> None:
        self._concept = concept.replace("_", " ").title()
        self._score = max(0.0, min(1.0, score))
        self._sign = sign
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        w = self.width()
        h = self.height()
        label_width = 160
        bar_x = label_width + 10
        bar_width = w - bar_x - 60
        bar_h = 16
        bar_y = (h - bar_h) / 2

        # Label
        painter.setPen(QColor("#7c8190"))
        font = QFont("Inter", 10, QFont.Weight.Medium)
        painter.setFont(font)
        label_rect = QRectF(0, 0, label_width, h)
        painter.drawText(
            label_rect,
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
            self._concept,
        )

        # Bar background (inset)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QColor("#111318"))
        painter.drawRoundedRect(QRectF(bar_x, bar_y, bar_width, bar_h), 3, 3)

        # Bar fill — gradient
        fill_width = bar_width * self._score
        if fill_width > 0:
            gradient = QLinearGradient(bar_x, 0, bar_x + fill_width, 0)
            if self._sign == "positive":
                gradient.setColorAt(0.0, QColor("#2a5b45"))
                gradient.setColorAt(1.0, QColor("#3d8b6e"))
            else:
                gradient.setColorAt(0.0, QColor("#5b2a2a"))
                gradient.setColorAt(1.0, QColor("#8b3d3d"))

            painter.setBrush(QBrush(gradient))
            painter.drawRoundedRect(QRectF(bar_x, bar_y, fill_width, bar_h), 3, 3)

        # Score text — monospace for alignment
        painter.setPen(QColor("#7c8190"))
        font = QFont("JetBrains Mono", 9)
        font.setStyleHint(QFont.StyleHint.Monospace)
        painter.setFont(font)
        score_rect = QRectF(bar_x + bar_width + 5, 0, 50, h)
        painter.drawText(
            score_rect,
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
            f"{self._score:.2f}",
        )

        painter.end()
