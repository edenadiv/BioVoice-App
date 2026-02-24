"""Real-time audio waveform display widget."""

import numpy as np
from PySide6.QtCore import Qt, Slot
from PySide6.QtGui import QBrush, QColor, QLinearGradient, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QWidget


class WaveformWidget(QWidget):
    """Displays a scrolling audio waveform using QPainter."""

    def __init__(self, parent=None, max_points: int = 2000):
        super().__init__(parent)
        self.max_points = max_points
        self._data = np.zeros(max_points, dtype=np.float32)
        self._color = QColor("#4e88a8")
        self._bg_color = QColor("#111318")
        self._center_color = QColor("#1a1d24")
        self._grid_color = QColor("#1a1d24")
        self.setMinimumHeight(100)
        self.setMinimumWidth(200)

    @Slot(np.ndarray)
    def append_chunk(self, chunk: np.ndarray) -> None:
        """Append new audio samples and scroll the display."""
        flat = chunk.flatten()
        n = len(flat)
        if n >= self.max_points:
            self._data[:] = flat[-self.max_points:]
        else:
            self._data = np.roll(self._data, -n)
            self._data[-n:] = flat
        self.update()

    def clear(self) -> None:
        self._data = np.zeros(self.max_points, dtype=np.float32)
        self.update()

    def set_color(self, color: QColor) -> None:
        self._color = color
        self.update()

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        w = self.width()
        h = self.height()
        mid_y = h / 2

        # Background
        painter.fillRect(0, 0, w, h, self._bg_color)

        # Grid — horizontal lines at 25% and 75% amplitude
        grid_pen = QPen(self._grid_color, 1)
        painter.setPen(grid_pen)
        painter.drawLine(0, int(mid_y), w, int(mid_y))  # center
        painter.drawLine(0, int(h * 0.25), w, int(h * 0.25))
        painter.drawLine(0, int(h * 0.75), w, int(h * 0.75))

        # Grid — vertical lines every 100px
        for vx in range(100, w, 100):
            painter.drawLine(vx, 0, vx, h)

        # Waveform
        if len(self._data) < 2:
            painter.end()
            return

        step = w / (self.max_points - 1)

        # Build path
        path = QPainterPath()
        path.moveTo(0, mid_y - self._data[0] * mid_y * 0.9)
        for i in range(1, self.max_points):
            x = i * step
            y = mid_y - self._data[i] * mid_y * 0.9
            path.lineTo(x, y)

        # Gradient fill — from waveform down to center line
        fill_path = QPainterPath(path)
        fill_path.lineTo(w, mid_y)
        fill_path.lineTo(0, mid_y)
        fill_path.closeSubpath()

        fill_gradient = QLinearGradient(0, 0, 0, mid_y)
        fill_color = QColor(self._color)
        fill_color.setAlpha(64)  # ~25% opacity at peaks
        transparent = QColor(self._color)
        transparent.setAlpha(0)
        fill_gradient.setColorAt(0.0, fill_color)
        fill_gradient.setColorAt(1.0, transparent)

        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(QBrush(fill_gradient))
        painter.drawPath(fill_path)

        # Glow — 6px wide, 40% opacity bloom
        glow_color = QColor(self._color)
        glow_color.setAlpha(102)  # ~40%
        glow_pen = QPen(glow_color, 6)
        glow_pen.setCapStyle(Qt.PenCapStyle.RoundCap)
        glow_pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
        painter.setPen(glow_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPath(path)

        # Main stroke — 2.0px
        pen = QPen(self._color, 2.0)
        painter.setPen(pen)
        painter.drawPath(path)

        painter.end()
