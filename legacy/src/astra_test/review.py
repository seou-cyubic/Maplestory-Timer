"""Offline evidence report; does not require a running game."""
import argparse,json,html
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
from .vision import ROOT,OCR,BuffClassifier,read_image,detect_minimap,detect_exp
from .detectors import RuneDetector,BoosterDetector

def generate(destination):
 destination=Path(destination);destination.mkdir(parents=True,exist_ok=True)
 o=OCR();c=BuffClassifier(o);r=RuneDetector();b=BoosterDetector(o)
 font=ImageFont.truetype('C:/Windows/Fonts/malgun.ttf',16)
 rows=[];cards=[]
 for index,p in enumerate(ROOT.glob('*.png')):
  im=read_image(p);h,w=im.shape[:2]
  if w>1000:
   mm=detect_minimap(im);ex=detect_exp(im,o);buffs=c.classify(im)
   record={'file':p.name,'minimap':mm,'experience':ex,'buff_count':len(buffs),'buffs':buffs,'rune':r.observe(im,mm),'booster':b.observe(im)}
   view=Image.fromarray(im[:,:,::-1]);draw=ImageDraw.Draw(view)
   for label,box,color in [('MAP',mm,'cyan'),('EXP',ex['bbox'],'cyan')]+[(v['id'],v['bbox'],'#ffdd55') for v in buffs]+[('BOOSTER',record['booster'].get('bbox'),'lime')]:
    if box:
     x,y,bw,bh=box;draw.rectangle((x,y,x+bw,y+bh),outline=color,width=2);draw.text((x,max(0,y-16)),label,font=font,fill=color,stroke_width=1,stroke_fill='black')
   output=f'screen_{index}.png';view.save(destination/output)
   potion=next((v for v in buffs if v['id']=='P04'),{})
   cards.append(f'<h2>{html.escape(p.name)}</h2><p>아이콘 후보 {len(buffs)}개 · 비약 {potion.get("remaining_seconds")}초 (표시 단위 {potion.get("resolution_seconds")}초) · 룬 {record["rune"]["present"]} · 부스터 {record["booster"].get("remaining_seconds")}초</p><img src="{output}">')
   cards.append('<table><tr><th>ID</th><th>이름</th><th>관측 시간</th><th>숫자</th></tr>')
   for v in buffs:
    n=v['remaining_seconds'];display='미확인' if n is None else f'{n//60}분' if v['resolution_seconds']==60 else f'{n//60}:{n%60:02}'
    cards.append('<tr>'+''.join(f'<td>{html.escape(str(t))}</td>' for t in [v['id'],v['name'] or '이름 미확인',display,v['raw_number'] or '—'])+'</tr>')
   cards.append('</table>')
  else:
   record={'file':p.name,'kind':'buff_reference' if h<50 else 'minimap_reference','width':w,'height':h}
   Image.open(p).save(destination/f'reference_{index}.png')
   cards.append(f'<h2>{html.escape(p.name)}</h2><img style="width:auto;max-width:100%" src="reference_{index}.png">')
  rows.append(record)
 (destination/'analysis.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
 (destination/'review.html').write_text('<!doctype html><meta charset="utf-8"><title>Astra 검증 보고서</title><style>body{background:#111b28;color:#e5edf7;font:16px sans-serif;max-width:1400px;margin:32px auto;padding:24px}img{width:100%}table{border-collapse:collapse;width:100%}td,th{padding:8px;border:1px solid #40546c;text-align:left}h2{margin-top:40px}</style><h1>사용자 제공 7개 표본 분석</h1><p>P04 = 소형 재물 획득의 비약, 분홍색 마름모 = 룬: 사용자 확인 완료. 분 표시는 초 단위 정확도가 아닌 분 해상도의 관측값입니다. 이름/숫자 의미가 확인되지 않은 아이콘은 미확인으로 표시합니다. 아래 결과는 제공 표본 회귀 검증이며 일반적인 탐지 정확도 수치가 아닙니다.</p>'+''.join(cards),encoding='utf-8')
 return rows

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True);a=p.parse_args();generate(a.output)
