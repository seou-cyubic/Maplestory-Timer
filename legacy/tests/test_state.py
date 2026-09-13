from astra_test.state import parse_experience,parse_time,ExperienceState,TimerState

def test_exact_integer():
    assert parse_experience('79.580.389.573.127[72.700%]')==79580389573127
    assert parse_experience('79,580,389,573,127 [72.700%]')==79580389573127
    assert parse_experience('79,58 [72.7%]') is None

def test_time_semantics():
    assert parse_time('9:59','clock')==599
    assert parse_time('28','minutes')==1680
    assert parse_time('230','stack') is None
    assert parse_time('9:60','clock') is None

def test_stall_once_then_rearm():
    s=ExperienceState();events=[]
    for i in range(90):
        if s.update(100,i*.1):events.append(i)
    assert len(events)==1
    s.update(101,9);s.update(102,9.1)
    assert not s.alerted

def test_gaps_are_not_idle():
    s=ExperienceState()
    s.update(100,0);s.update(100,.1)
    assert not s.update(100,8)
    assert s.status=='BASELINING'

def test_increase_at_threshold():
    s=ExperienceState()
    for i in range(71):assert not s.update(100,i*.1)
    assert not s.update(101,7.1)
    assert not s.update(102,7.2)

def test_timer_stale():
    s=TimerState();s.observe(165,0,1)
    assert s.read(1)['remaining_seconds']==164
    assert s.read(3)['remaining_seconds'] is None
