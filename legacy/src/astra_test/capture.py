"""Read-only Win32 client capture. Never sends game input."""
import ctypes as C
from ctypes import wintypes as W
from dataclasses import dataclass, asdict
from PIL import Image

user32 = C.WinDLL('user32', use_last_error=True)
user32.SetProcessDpiAwarenessContext(C.c_void_p(-4))

@dataclass
class GameWindow:
    hwnd: int
    title: str
    pid: int
    x: int
    y: int
    width: int
    height: int
    minimized: bool

def find_windows():
    found = []
    callback_type = C.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
    @callback_type
    def callback(hwnd, _):
        title = C.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, title, 512)
        if title.value.lower() != 'maplestory':
            return True
        rect, point, pid = W.RECT(), W.POINT(), W.DWORD()
        user32.GetClientRect(hwnd, C.byref(rect))
        user32.ClientToScreen(hwnd, C.byref(point))
        user32.GetWindowThreadProcessId(hwnd, C.byref(pid))
        found.append(GameWindow(int(hwnd), title.value, pid.value, point.x, point.y,
                                rect.right, rect.bottom, bool(user32.IsIconic(hwnd))))
        return True
    user32.EnumWindows(callback, 0)
    return found


class CaptureStream:
    """Latest-frame WGC stream, client coordinates, no foreground requirement."""
    def __init__(self, window):
        import threading
        from windows_capture import WindowsCapture
        self.window = window
        self.lock = threading.Lock()
        self.latest = None
        self.closed = False
        self.error = None
        self.sequence = 0
        self.cap = WindowsCapture(cursor_capture=False, window_hwnd=window.hwnd,
                                  minimum_update_interval=66)
        @self.cap.event
        def on_frame_arrived(frame, control):
            import time
            try:
                rect = W.RECT()
                # WGC uses extended frame bounds; client origin is converted to that space.
                dwm = C.WinDLL('dwmapi')
                ok = dwm.DwmGetWindowAttribute(W.HWND(window.hwnd), 9,
                                               C.byref(rect), C.sizeof(rect))
                if ok != 0:
                    user32.GetWindowRect(window.hwnd, C.byref(rect))
                point = W.POINT()
                user32.ClientToScreen(window.hwnd, C.byref(point))
                client = W.RECT()
                user32.GetClientRect(window.hwnd, C.byref(client))
                x, y = point.x-rect.left, point.y-rect.top
                w, h = client.right, client.bottom
                if x < 0 or y < 0 or x+w > frame.width or y+h > frame.height:
                    raise RuntimeError('WGC client geometry mismatch')
                image = frame.frame_buffer[y:y+h, x:x+w, :3].copy()
                with self.lock:
                    self.sequence += 1
                    self.latest = (self.sequence, time.monotonic(), image)
            except Exception as exc:
                self.error = str(exc)
                control.stop()
        @self.cap.event
        def on_closed():
            self.closed = True
        self.control = self.cap.start_free_threaded()

    def read(self, max_age=0.5):
        import time
        if self.error:
            raise RuntimeError(self.error)
        if self.closed or user32.IsIconic(self.window.hwnd):
            return None
        with self.lock:
            item = self.latest
        if item is None or time.monotonic()-item[1] > max_age:
            return None
        return item

    def stop(self):
        if not self.control.is_finished():
            self.control.stop()


def capture(window, timeout=5):
    import time
    stream = CaptureStream(window)
    try:
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            item = stream.read()
            if item:
                return Image.fromarray(item[2][:,:,::-1])
            time.sleep(0.02)
        raise TimeoutError('No fresh WGC frame')
    finally:
        stream.stop()

if __name__ == '__main__':
    import json, sys
    windows = find_windows()
    print(json.dumps([asdict(w) for w in windows], ensure_ascii=False))
    if windows:
        capture(windows[0]).save(sys.argv[1])
