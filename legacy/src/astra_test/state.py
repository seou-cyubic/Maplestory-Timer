import re
from dataclasses import dataclass

def parse_experience(text):
    # OCR often renders the game's thousands commas as dots.
    match = re.fullmatch(r'\s*(\d{1,3}(?:[,.]\d{3})+|\d+)\s*\[\s*(\d{1,3}\.\d{1,3})\s*%\s*\]\s*', text)
    if not match or not 0 <= float(match[2]) <= 100:
        return None
    return int(re.sub(r'[,.]', '', match[1]))

def parse_time(text, mode):
    text = text.strip().replace(' ', '')
    if mode == 'clock':
        m = re.fullmatch(r'(\d{1,2}):(\d{2})', text)
        if m and int(m[2]) < 60:
            return int(m[1])*60+int(m[2])
    if mode in ('minutes', 'seconds') and re.fullmatch(r'\d{1,3}', text):
        return int(text)*(60 if mode == 'minutes' else 1)
    return None

@dataclass
class ExperienceState:
    value: int | None = None
    last_seen: float | None = None
    since: float | None = None
    pending: tuple | None = None
    alerted: bool = False
    status: str = 'BASELINING'

    def update(self, value, now):
        if value is None:
            self.last_seen = None
            self.pending = None
            self.since = None
            self.status = 'UNKNOWN'
            return False
        if self.last_seen is None or now-self.last_seen > 0.5:
            self.pending = (value, now)
            self.value = None
            self.since = now
            self.alerted = False
            self.status = 'BASELINING'
        self.last_seen = now
        if self.value is None:
            if self.pending and value >= self.pending[0] and now > self.pending[1]:
                self.value = value
                self.since = now
                self.pending = None
                self.status = 'TRACKING'
            else:
                self.pending = (value, now)
            return False
        if value < self.value:
            self.value = None
            self.pending = (value, now)
            self.since = now
            self.status = 'BASELINING'
            self.alerted = False
            return False
        if value > self.value:
            if self.pending and value >= self.pending[0]:
                self.value = value
                self.since = self.pending[1]
                self.pending = None
                self.alerted = False
                self.status = 'TRACKING'
            else:
                self.pending = (value, now)
            return False
        self.pending = None
        if now-self.since >= 7 and not self.alerted:
            self.alerted = True
            self.status = 'STALLED'
            return True
        return False

class TimerState:
    def __init__(self):
        self.deadline = None
        self.last_seen = None
        self.resolution = None

    def observe(self, remaining, now, resolution):
        if remaining is None:
            return
        self.deadline = now+remaining
        self.last_seen = now
        self.resolution = resolution

    def read(self, now):
        if self.last_seen is None or now-self.last_seen > 2:
            return {'remaining_seconds': None, 'source': 'unknown'}
        return {'remaining_seconds': max(0, self.deadline-now),
                'resolution_seconds': self.resolution,
                'source': 'observed' if now == self.last_seen else 'propagated'}

class PresenceGate:
    """Confirm two consecutive observations; unknown never means disappeared."""
    def __init__(self,max_gap=3):
        self.max_gap=max_gap
        self.count=0;self.active=False;self.last=None
    def update(self,present,now):
        if self.last is not None and now-self.last>self.max_gap:self.count=0
        self.last=now
        if present is None:self.count=0;return False
        if not present:self.count=0;self.active=False;return False
        self.count+=1
        if self.count>=2 and not self.active:self.active=True;return True
        return False

class ExpirationGate:
    """Only infer expiration from a recently observed final seconds countdown."""
    def __init__(self):
        self.last=None;self.remaining=None;self.armed=False;self.alerted=False
    def update(self,remaining,resolution,now,visible=True):
        if not visible:
            self.last=None;self.armed=False
            return False
        if remaining is not None:
            if remaining>5:self.alerted=False
            if remaining==0 and self.armed and not self.alerted:
                self.alerted=True;return True
            consistent=(self.last is not None and now-self.last<=3 and self.remaining is not None
                        and abs((self.remaining-remaining)-(now-self.last))<=2)
            self.last=now;self.remaining=remaining
            self.armed=consistent and resolution==1 and 0<remaining<=5
            return False
        if self.armed and self.last is not None:
            elapsed=now-self.last
            if elapsed>8:self.armed=False
            elif elapsed>=self.remaining+1 and not self.alerted:
                self.alerted=True;return True
        return False
