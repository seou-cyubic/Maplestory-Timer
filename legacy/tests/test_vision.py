import cv2
import pytest
from astra_test.vision import ROOT,OCR,BuffClassifier,detect_minimap,detect_exp

@pytest.fixture(scope='module')
def vision():
    o=OCR()
    return o,BuffClassifier(o)

def test_user_verified_initial_capture(vision):
    o,c=vision;image=cv2.imread(str(ROOT/'assets/candidates/client.png'))
    assert detect_exp(image,o)['value']==79580389573127
    x,y,w,h=detect_minimap(image)
    assert abs(x-7)<4 and abs(y-68)<4 and abs(w-195)<5 and abs(h-121)<5
    entries=c.classify(image)
    assert len(entries)==9
    assert next(x for x in entries if x['id']=='B01')['remaining_seconds']==1680
    assert next(x for x in entries if x['id']=='B03')['remaining_seconds'] is None

def test_user_verified_timed_capture(vision):
    _,c=vision;image=cv2.imread(str(ROOT/'assets/candidates/timed_client.png'))
    entries=c.classify(image)
    assert len(entries)==10
    assert next(x for x in entries if x['id']=='T01')['remaining_seconds']==165
    assert next(x for x in entries if x['id']=='T02')['remaining_seconds']==2340

def test_no_game_ui_is_unknown(vision):
    import numpy as np
    o,c=vision;blank=np.zeros((768,1366,3),dtype=np.uint8)
    assert detect_minimap(blank) is None
    assert detect_exp(blank,o)['value'] is None
    assert c.classify(blank)==[]
