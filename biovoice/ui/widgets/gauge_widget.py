"""Circular gauge widget for displaying similarity score."""

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QConicalGradient,
    QFont,
    QPainter,
    QPen,
    QRadialGradient,
)
from PySide6.QtWidgets import QWidget


class GaugeWidget(QWidget):
    """Circular gauge displaying a score from 0.0 to 1.0."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._score = 0.0
        self._label = "Score"
        self._threshold = 0.75
        self.setMinimumSize(180, 180)

    def set_score(self, score: float) -> None:
        self._score = max(0.0, min(1.0, score))
        self.update()

    def set_label(self, label: str) -> None:
        self._label = label
        self.update()

    def set_threshold(self, threshold: float) -> None:
        self._threshold = threshold
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        size = min(self.width(), self.height()) - 20
        x = (self.width() - size) / 2
        y = (self.height() - size) / 2
        cx = x + size / 2
        cy = y + size / 2

        # 1. Shadow ring — outer dark arc
        shadow_rect = QRectF(x - 2, y - 2, size + 4, size + 4)
        pen = QPen(QColor("#111318"), 16)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.drawArc(shadow_rect, 225 * 16, -270 * 16)

        # 2. Track ring — inset arc
        rect = QRectF(x, y, size, size)
        pen = QPen(QColor("#1e2129"), 12)
        pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(pen)
        painter.drawArc(rect, 225 * 16, -270 * 16)

        # 3. Score arc — conical gradient
        if self._score > 0.001:
            if self._score >= self._threshold:
                color_dark = QColor("#2a6b50")
                color_bright = QColor("#4ea882")
            else:
                color_dark = QColor("#6b2a2a")
                color_bright = QColor("#a84e4e")

            # Conical gradient centered on the gauge
            gradient = QConicalGradient(QPointF(cx, cy), 225)
            gradient.setColorAt(0.0, color_bright)
            gradient.setColorAt(self._score * 0.75, color_dark)
            gradient.setColorAt(1.0, color_dark)

            pen = QPen(QBrush(gradient), 12)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            span = int(-270 * self._score * 16)
            painter.drawArc(rect, 225 * 16, span)

        # 4. Center disc — radial gradient for glass panel feel
        disc_r = size / 2 - 20
        disc_rect = QRectF(cx - disc_r, cy - disc_r, disc_r * 2, disc_r * 2)
        radial = QRadialGradient(QPointF(cx, cy), disc_r)
        radial.setColorAt(0.0, QColor("#222d2d"))
        radial.setColorAt(1.0, QColor("#14161c"))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(radial))
        painter.drawEllipse(disc_rect)

        # 5. Threshold tick — radial line
        threshold_angle = 225 - 270 * self._threshold
        rad = math.radians(threshold_angle)
        inner_r = size / 2 - 14
        outer_r = size / 2 + 2
        ix = cx + inner_r * math.cos(rad)
        iy = cy - inner_r * math.sin(rad)
        ox = cx + outer_r * math.cos(rad)
        oy = cy - outer_r * math.sin(rad)
        pen = QPen(QColor("#c8cad0"), 2)
        painter.setPen(pen)
        painter.drawLine(QPointF(ix, iy), QPointF(ox, oy))

        # 6. Score text
        painter.setPen(QColor("#e8eaef"))
        font = QFont("Inter", 26, QFont.Weight.Bold)
        painter.setFont(font)
        score_text = f"{self._score:.0%}"
        painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, score_text)

        # 7. Label — uppercase
        font = QFont("Inter", 10, QFont.Weight.Medium)
        painter.setFont(font)
        painter.setPen(QColor("#7c8190"))
        label_rect = QRectF(x, y + size * 0.6, size, size * 0.3)
        painter.drawText(
            label_rect,
            Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop,
            self._label.upper(),
        )

        painter.end()
