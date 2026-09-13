"""Independent HUD and CAPTCHA workers keep EXP sampling responsive."""
import threading
import time
from .vision import OCR, BuffClassifier, detect_minimap, buff_visibility
from .detectors import RuneDetector, BoosterDetector, LieDetector

class AuxiliaryWorkers:
    def __init__(self,stream,stop):
        self.stream=stream;self.stop=stop;self.lock=threading.Lock()
        self.results={};self.threads=[]
        for kind in ('hud','buffs','lie'):
            t=threading.Thread(target=self.run,args=(kind,),daemon=True)
            t.start();self.threads.append(t)
    def publish(self,kind,value):
        with self.lock:self.results[kind]=value
    def snapshot(self,now):
        with self.lock:result=dict(self.results)
        return {k:v for k,v in result.items() if now-v['stamp']<(6 if k in ('lie','buffs') else 3) or 'error' in v}
    def run(self,kind):
        try:
            if kind in ('hud','buffs'):
                ocr=OCR();buffs=BuffClassifier(ocr);rune=RuneDetector();booster=BoosterDetector(ocr)
            else:lie=LieDetector()
            last=-1
            while not self.stop.is_set():
                item=self.stream.read()
                if not item or item[0]==last:self.stop.wait(.05);continue
                last,stamp,image=item;start=time.monotonic()
                if kind=='hud':
                    minimap=detect_minimap(image)
                    result={'stamp':stamp,'minimap_bbox':minimap,'buff_visibility':buff_visibility(image),'wealth':next(iter(buffs.classify(image,ids={'P04'})),None),
                            'rune':rune.observe(image,minimap),'booster':booster.observe(image)}
                elif kind=='buffs':result={'stamp':stamp,'buffs':buffs.classify(image)}
                else:result={'stamp':stamp,'lie_detector':lie.observe(image)}
                result['processing_ms']=round((time.monotonic()-start)*1000,2)
                self.publish(kind,result)
                self.stop.wait(max(0,(.5 if kind=='hud' else 2 if kind=='buffs' else 1)-(time.monotonic()-start)))
        except Exception as exc:
            self.publish(kind,{'stamp':time.monotonic(),'error':str(exc)})
    def close(self):
        self.stop.set()
        for t in self.threads:t.join(timeout=3)
