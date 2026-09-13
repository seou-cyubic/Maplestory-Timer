"""Presence detection only: never decodes or answers CAPTCHA challenges."""
import re
from difflib import SequenceMatcher
import cv2
import numpy as np
from .vision import ROOT, OCR_OPTIONS

class RuneDetector:
    def __init__(self):
        self.template=cv2.imread(str(ROOT/'assets/candidates/rune_marker.png'))

    def observe(self,image,minimap):
        if minimap is None:return {'status':'unknown','present':False}
        x,y,w,h=minimap;area=image[y:y+h,x:x+w]
        template=self.template
        if area.shape[0]<template.shape[0] or area.shape[1]<template.shape[1]:
            return {'status':'unknown','present':False}
        hsv=cv2.cvtColor(area,cv2.COLOR_BGR2HSV)
        color=cv2.inRange(hsv,(135,60,110),(175,255,255))
        score=cv2.matchTemplate(area,template,cv2.TM_CCOEFF_NORMED)
        _,best,_,loc=cv2.minMaxLoc(score)
        lx,ly=loc
        colored=np.count_nonzero(color[ly:ly+template.shape[0],lx:lx+template.shape[1]])
        return {'status':'observed','present':best>=.78 and colored>=4,
                'score':float(best),'bbox':[x+lx,y+ly,template.shape[1],template.shape[0]]}

class BoosterDetector:
    def __init__(self,ocr):
        self.ocr=ocr
        image=cv2.imread(str(ROOT/'assets/candidates/booster_timer.png'))
        self.anchor=image[6:27,5:78]

    def observe(self,image):
        h,w=image.shape[:2]
        area=image[:min(250,h),int(w*.25):int(w*.75)]
        m=cv2.matchTemplate(area,self.anchor,cv2.TM_CCOEFF_NORMED)
        _,best,_,loc=cv2.minMaxLoc(m)
        if best<.78:return {'status':'absent','remaining_seconds':None,'score':float(best)}
        x=loc[0]+int(w*.25)-5;y=loc[1]-6
        crop=image[max(0,y+8):y+48,x+80:x+183]
        text,confidence=self.ocr.line(crop)
        match=re.fullmatch(r'(\d{1,3})[.,](\d{2})',text.strip())
        remaining=float(match[1]+'.'+match[2]) if match and confidence>=.85 else None
        if remaining is not None and not 0<=remaining<=100:remaining=None
        return {'status':'observed' if remaining is not None else 'unknown',
                'remaining_seconds':remaining,'raw':text,'score':float(best),
                'ocr_score':confidence,'bbox':[x,y,202,57],'resolution_seconds':1}

class LieDetector:
    def __init__(self):
        from rapidocr import RapidOCR,LangRec,ModelType,OCRVersion
        self.ocr=RapidOCR(params={**OCR_OPTIONS,'Rec.lang_type':LangRec.KOREAN,
                         'Rec.model_type':ModelType.MOBILE,'Rec.ocr_version':OCRVersion.PPOCRV4})
        self.sift=cv2.SIFT_create(nfeatures=1800,contrastThreshold=.02)
        self.references=[]
        # Only stable instruction regions, excluding challenge text and answers.
        regions=[('user_type_1.webp',(20,48,220,117)),
                 ('user_type_2.webp',(20,62,218,215)),
                 ('user_type_3.webp',(24,42,329,244)),
                 ('user_type_4.webp',(45,55,284,89)),
                 ('video_frame_0.png',(0,0,460,24)),
                 ('video_frame_0.png',(75,323,432,360)),
                 ('violet_controls.png',(0,0,519,51))]
        for file,b in regions:
            a=cv2.imread(str(ROOT/'assets/lie_detector'/file));x,y,x2,y2=b
            gray=cv2.cvtColor(a[y:y2,x:x2],cv2.COLOR_BGR2GRAY)
            kp,desc=self.sift.detectAndCompute(gray,None)
            if desc is not None:self.references.append((file,gray,kp,desc))
        self.matcher=cv2.BFMatcher()

    def observe(self,image):
        gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
        kp,desc=self.sift.detectAndCompute(gray,None)
        evidence=[]
        if desc is not None:
            for name,ref,rkp,rd in self.references:
                pairs=self.matcher.knnMatch(rd,desc,k=2)
                good=[p[0] for p in pairs if len(p)==2 and p[0].distance<.70*p[1].distance]
                if len(good)<6:continue
                src=np.float32([rkp[m.queryIdx].pt for m in good]).reshape(-1,1,2)
                dst=np.float32([kp[m.trainIdx].pt for m in good]).reshape(-1,1,2)
                H,mask=cv2.findHomography(src,dst,cv2.RANSAC,4)
                if H is None or mask is None:continue
                inliers=int(mask.sum());ratio=inliers/len(good)
                if inliers>=6 and ratio>=.65:
                    corners=np.float32([[0,0],[ref.shape[1],0],[ref.shape[1],ref.shape[0]],[0,ref.shape[0]]]).reshape(-1,1,2)
                    box=cv2.perspectiveTransform(corners,H).reshape(-1,2)
                    area=abs(cv2.contourArea(box))
                    scale=area/(ref.shape[0]*ref.shape[1])
                    if .2<scale<6 and cv2.isContourConvex(box):
                        evidence.append({'method':'instruction_features','type':name,'inliers':inliers,'ratio':ratio})
        if evidence:return {'present':True,'status':'observed','evidence':evidence}
        # Semantic fallback handles instruction noise and layout changes.
        # OCR output is used transiently; challenge contents are not logged or returned.
        ocr_image=image
        if image.shape[1]>960:
            ih,iw=image.shape[:2]
            # Full-frame features above; semantic fallback focuses on the central prompt area.
            ocr_image=image[int(ih*.04):int(ih*.82),int(iw*.12):int(iw*.88)]
            oh,ow=ocr_image.shape[:2]
            ocr_image=cv2.resize(ocr_image,(800,round(oh*800/ow)))
        result=self.ocr(ocr_image,use_cls=False)
        strings=[re.sub(r'\s+','',t) for t,s in zip(result.txts or (),result.scores or ()) if s>.45]
        joined=''.join(strings)
        phrases=['거짓말탐지기','입력을위해먼저','올바른문장을선택','아래이미지안의한글','마우스를움직여따라가','매크로로적발','LIEDETECTOR']
        hits=[]
        for phrase in phrases:
            if phrase in joined:hits.append(phrase);continue
            if any(SequenceMatcher(None,phrase,s).ratio()>.72 for s in strings):hits.append(phrase)
        # Generic name alone can occur in chat; require a task-specific instruction.
        if hits and (len(hits)>=2 or any(h not in ('거짓말탐지기','매크로로적발') for h in hits)):evidence.append({'method':'fixed_instruction_ocr','matched_prompts':hits})
        return {'present':bool(evidence),'status':'observed','evidence':evidence}
