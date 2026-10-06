"""Presence detection only."""
import re
import cv2
import numpy as np
from .vision import ROOT

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
