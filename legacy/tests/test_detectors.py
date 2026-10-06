import pytest
from astra_test.vision import ROOT,read_image,OCR,BuffClassifier,detect_minimap,detect_exp
from astra_test.detectors import RuneDetector,BoosterDetector
from astra_test.state import PresenceGate,ExpirationGate

@pytest.fixture(scope='module')
def engines():
 o=OCR();return o,BuffClassifier(o),RuneDetector(),BoosterDetector(o)

@pytest.mark.parametrize('suffix,wealth,rune,booster,exp',[
 ('154810',1740,False,69.,83874301109098),
 ('160308',840,True,None,84139522751307),
 ('160802',561,True,None,84184389743780),
 ('160817',547,False,None,84186422823710),
 ('160827',531,False,None,84189282981043)])
def test_provided_full_screens(engines,suffix,wealth,rune,booster,exp):
 o,c,r,b=engines
 p=next(p for p in ROOT.glob('*.png') if suffix in p.name)
 im=read_image(p);entries=c.classify(im)
 assert next(v for v in entries if v['id']=='P04')['remaining_seconds']==wealth
 assert r.observe(im,detect_minimap(im))['present']==rune
 assert b.observe(im)['remaining_seconds']==booster
 assert detect_exp(im,o)['value']==exp
 assert len({tuple(v['bbox'][:2]) for v in entries})==len(entries)

def test_expiration_requires_final_countdown_and_valid_capture():
 g=ExpirationGate()
 assert not g.update(1740,60,0)
 assert not g.update(None,None,1742)
 assert not g.update(4,1,1799)
 assert not g.update(3,1,1800)
 assert not g.update(None,None,1802)
 assert g.update(None,None,1804)
 assert not g.update(None,None,1805)
 g.update(3,1,1900)
 assert not g.update(None,None,1901,visible=False)
 assert not g.update(None,None,1905)

def test_presence_confirmation():
 g=PresenceGate()
 assert not g.update(True,0)
 assert g.update(True,.5)
 assert not g.update(True,1)
 assert not g.update(False,2)
 assert not g.update(True,3)
 assert g.update(True,3.5)

def test_user_confirmed_additional_units(engines):
 _,c,_,_=engines
 entries={b['id']:b for b in c.classify(read_image(ROOT/'Maple_260905_160827.png'))}
 expected={'U00':311,'U01':319,'U02':28,'U05':57,'U06':57,'U07':57,'U08':57,'U10':19,'U11':19,'U12':22,'U13':247,'U14':840,'U15':530,'U16':530,'U17':530}
 assert len(entries)==35
 for key,value in expected.items():assert entries[key]['remaining_seconds']==value,(key,entries[key])


def test_synthetic_potion_under_one_minute(engines):
 _,c,_,_=engines
 im=read_image(ROOT/'Maple_260905_160827.png')
 # Actual user-confirmed 57-second glyph crop inserted into the potion cell.
 # Synthetic transition test, not an independently captured potion sample.
 im[109+9:109+27,1203:1235]=im[3+9:3+27,1235:1267].copy()
 potion=next(b for b in c.classify(im) if b['id']=='P04')
 assert potion['remaining_seconds']==57
 assert potion['resolution_seconds']==1
