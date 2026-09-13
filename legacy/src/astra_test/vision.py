import json
from pathlib import Path
import cv2
import numpy as np
from .state import parse_experience, parse_time

OCR_OPTIONS={'EngineConfig.onnxruntime.intra_op_num_threads':2,
             'EngineConfig.onnxruntime.inter_op_num_threads':1,'Global.log_level':'warning'}
cv2.setNumThreads(2)

ROOT = Path(__file__).resolve().parents[2]

def read_image(path):
    return cv2.imdecode(np.frombuffer(Path(path).read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR)

class OCR:
    def __init__(self):
        from rapidocr import RapidOCR, LangRec, ModelType, OCRVersion
        self.engine = RapidOCR(params=OCR_OPTIONS)
        self.digits = RapidOCR(params={**OCR_OPTIONS,'Rec.lang_type':LangRec.EN,
                              'Rec.model_type':ModelType.MOBILE,
                              'Rec.ocr_version':OCRVersion.PPOCRV4})

    def line(self, crop):
        if not crop.size:
            return '', 0.0
        enlarged = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
        result = self.engine(enlarged, use_det=False, use_cls=False)
        if not result.txts:
            return '', 0.0
        return result.txts[0], float(result.scores[0])

    def minutes(self, image, box):
        from collections import Counter
        x,y,w,h=box
        readings=[]
        for dx,dy,cw,ch in [(-2,12,33,20),(-2,15,22,17),(0,14,24,16),
                             (0,18,18,h-18),(0,22,18,h-22),(0,22,22,h-22),(0,16,26,20),(0,18,26,18),(-3,20,27,16),(-2,20,24,16)]:
            crop=image[max(0,y+dy):y+dy+ch,max(0,x+dx):x+dx+cw]
            if not crop.size:continue
            z=self.digits(cv2.resize(crop,None,fx=4,fy=4),use_det=False,use_cls=False)
            if z.txts and z.txts[0].isdigit() and z.scores[0]>=.35:
                readings.append((z.txts[0],float(z.scores[0])))
        if not readings:return '',0.0,False
        text,count=Counter(t for t,s in readings).most_common(1)[0]
        scores=[s for t,s in readings if t==text]
        return text,sum(scores)/len(scores),count>=2
    def timer(self,crop,mode):
        from collections import Counter
        readings=[]
        for y1,y2 in ((5,25),(8,26),(6,29),(3,27)):
            text,score=self.line(crop[y1:y2,:])
            value=parse_time(text,mode)
            if value is not None and score>=.85 and (mode!='seconds' or value<60):
                if score>=.95:return text,score
                readings.append((text,score))
        if not readings:return '',0.0
        counts=Counter(t for t,s in readings)
        best=max(readings,key=lambda ts:(counts[ts[0]],ts[1]))
        return best


def detect_minimap(image):
    h, w = image.shape[:2]
    search = image[:min(h,max(240,h//2)), :min(w,max(300,w//3))]
    gray = cv2.cvtColor(search, cv2.COLOR_BGR2GRAY)
    contours, _ = cv2.findContours(cv2.Canny(gray, 60, 150), cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates = []
    for c in contours:
        x,y,bw,bh = cv2.boundingRect(c)
        if 100 <= bw <= min(w,400) and 60 <= bh <= min(h,220) and 40 < y < 140 and x<40:
            perimeter = cv2.arcLength(c, True)
            poly = cv2.approxPolyDP(c, perimeter*0.025, True)
            if 4 <= len(poly) <= 8:
                candidates.append((bw*bh, [x,y,bw,bh]))
    return max(candidates)[1] if candidates else None

def detect_exp(image, ocr):
    h,w = image.shape[:2]
    # Client-relative HUD prior, validated by full integer + percent grammar.
    x1,x2,y1 = int(w*0.435),int(w*0.574),h-12
    crop = image[y1:h,x1:x2]
    text,score = ocr.line(crop)
    value = parse_experience(text) if score >= 0.90 else None
    return {'bbox':[x1,y1,x2-x1,h-y1], 'raw':text, 'score':score,
            'value':value, 'valid':value is not None}

def icon_candidates(image):
    h,w = image.shape[:2]
    x0 = int(w*0.5)
    gray = cv2.cvtColor(image[:min(180,h//3),x0:],cv2.COLOR_BGR2GRAY)
    contours,_=cv2.findContours(cv2.Canny(gray,70,160),cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[]
    for c in contours:
        x,y,bw,bh=cv2.boundingRect(c)
        if 27<=bw<=36 and 27<=bh<=36 and abs(bw-bh)<=3:
            box=[x+x0,y,bw,bh]
            if not any(abs(box[0]-b[0])<8 and abs(box[1]-b[1])<8 for b in boxes):
                boxes.append(box)
    return sorted(boxes,key=lambda b:(b[1]//12,b[0]))

class BuffClassifier:
    def __init__(self, ocr):
        self.ocr=ocr
        self.registry=[]
        self.reload()

    def reload(self):
        path=ROOT/'config'/'labels.json'
        self.registry=json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else []
        for item in self.registry:
            item['_template']=cv2.imread(str(ROOT/item['image']))

    def classify(self,image,ids=None):
        boxes=icon_candidates(image)
        # Boundary icons may have an open contour; match registered examples as well.
        area=image[:180,image.shape[1]//2:]
        matched=[]
        for item in self.registry:
            if ids is not None and item['id'] not in ids:continue
            template=item['_template']
            if template is None: continue
            # Top 14 pixels avoid numeric stacks/timers in the lower icon area.
            end=9 if item.get('time_mode') in ('clock','wealth') or item['id'].startswith(('P','U')) else 14
            patch=template[2:end,2:-2]
            score=cv2.matchTemplate(area,patch,cv2.TM_CCOEFF_NORMED)
            _,best,_,loc=cv2.minMaxLoc(score)
            if best>=0.90:
                x=loc[0]+image.shape[1]//2-2;y=loc[1]-2
                box=[x,y,template.shape[1],template.shape[0]]
                if x<0 or y<0:continue
                matched.append((box,item,best))
                boxes=[b for b in boxes if abs(b[0]-x)>8 or abs(b[1]-y)>8]
        entries=[(b,None,0) for b in boxes]+matched
        # Buff rows are contiguous 32-pixel cells anchored at the right HUD edge.
        # Reject isolated scenery contours and recover cells with broken borders.
        grid=[]; used=set()
        for anchor in sorted(entries,key=lambda e:e[0][1]):
            ab=anchor[0]
            if ab[0]<image.shape[1]-40 or any(abs(ab[1]-y)<6 for y in used):continue
            ax,ay=ab[:2];used.add(ay)
            row={}
            for entry in entries:
                b=entry[0];slot=round((ax-b[0])/32)
                if slot>=0 and abs(b[1]-ay)<=5 and abs(ax-slot*32-b[0])<=3:
                    if slot not in row or entry[2]>row[slot][2]:row[slot]=entry
            # Stop at a gap larger than three cells; distant scene squares are not buffs.
            extent=0
            for slot in sorted(row):
                if slot-extent>4:break
                extent=slot
            row_y=min(e[0][1] for k,e in row.items() if k<=extent)
            for slot in range(extent+1):
                entry=row.get(slot)
                if entry is None:entry=([ax-slot*32,ay,32,32],None,0)
                if entry[1] is None:entry=([ax-slot*32,row_y,32,32],None,0)
                grid.append(entry)
        entries=grid if ids is None else matched
        result=[]
        for i,(box,item,score) in enumerate(sorted(entries,key=lambda z:(z[0][1]//12,z[0][0]))):
            x,y,w,h=box;crop=image[y:y+h,x:x+w]
            hsv=cv2.cvtColor(crop,cv2.COLOR_BGR2HSV)
            yellow=cv2.inRange(hsv,(18,90,160),(40,255,255))
            center=yellow[8:27,2:-2]
            text,confidence=self.ocr.line(crop[12:,:])
            mode=(item or {}).get('time_mode','unknown')
            if np.count_nonzero(center)>12 and mode not in ('stack','none'):
                clock_text,clock_score=self.ocr.line(crop[8:26,:])
                if clock_score>=0.90 and parse_time(clock_text,'clock') is not None:
                    text,confidence,mode=clock_text,clock_score,'clock'
                elif mode in ('minutes','wealth'):
                    seconds_text,seconds_score=self.ocr.timer(crop,'seconds')
                    if seconds_score>=.95:
                        text,confidence,mode=seconds_text,seconds_score,'seconds'
            if mode in ('clock','seconds'):
                text,confidence=self.ocr.timer(crop,mode)
            minute_consensus=False
            if mode=='minutes':
                text,confidence,minute_consensus=self.ocr.minutes(image,box)
            if mode=='wealth':
                text,confidence,minute_consensus=self.ocr.minutes(image,box);mode='minutes'
            remaining=parse_time(text,mode) if confidence>=0.9 or minute_consensus else None
            approved=bool(item and item.get('approved'))
            if not approved and mode!='clock': remaining=None
            result.append({'id':item['id'] if item else f'unknown-{i}',
                           'name':item.get('name') if item else None,
                           'bbox':box,'match_score':float(score),'approved':approved,
                           'raw_number':text if confidence>=0.85 or minute_consensus else None,
                           'ocr_score':confidence,'time_mode':mode,
                           'minute_consensus':minute_consensus,
                           'remaining_seconds':remaining,
                           'resolution_seconds':60 if mode=='minutes' else 1 if mode in ('clock','seconds') else None,
                           'time_status':'observed' if remaining is not None else 'not_visible_or_unconfirmed'})
        return result


def buff_visibility(image):
    # A large dark in-game tooltip can cover the buff row even under WGC.
    if image.shape[1]<700:return 'unknown'
    region=image[30:160,-380:]
    hsv=cv2.cvtColor(region,cv2.COLOR_BGR2HSV)
    covered=float(np.mean((hsv[:,:,2]<140)&(hsv[:,:,1]<130)))>.8
    return 'obscured' if covered else 'observable'
