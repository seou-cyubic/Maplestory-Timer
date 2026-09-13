import argparse
import json
import queue
import threading
import time
from dataclasses import asdict
from pathlib import Path
import cv2
from .capture import find_windows, CaptureStream
from .vision import ROOT, OCR, BuffClassifier, detect_minimap, detect_exp
from .state import ExperienceState, PresenceGate, ExpirationGate
from .workers import AuxiliaryWorkers

def write_json(path, value):
    path.parent.mkdir(parents=True,exist_ok=True)
    tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8')
    tmp.replace(path)

def run_observer(stop, updates=None, seconds=None, sound=False):
    ocr=OCR(); state=ExperienceState()
    gates={k:PresenceGate(6 if k=='lie_detector' else 3) for k in ('rune','lie_detector')}
    expiry={k:ExpirationGate() for k in ('wealth','booster')}
    processed={}; last_alert=None
    windows=find_windows()
    if not windows: raise RuntimeError('MapleStory 창을 찾지 못했습니다.')
    window=windows[0];stream=CaptureStream(window)
    auxiliaries=AuxiliaryWorkers(stream,threading.Event())
    (ROOT/'work').mkdir(exist_ok=True)
    start=time.monotonic();last_id=-1;last_buffs=-10;last_write=-10
    buff_result=[];minimap=None;frames=0;times=[];last_report=None
    try:
        while not stop.is_set() and (seconds is None or time.monotonic()-start<seconds):
            item=stream.read()
            if not item:
                now=time.monotonic()
                if now-last_write>=1:
                    last_report={'health':'캡처 대기 / 최소화 / 프레임 유실','captured_at':time.strftime('%Y-%m-%d %H:%M:%S')}
                    write_json(ROOT/'work/latest.json',last_report);last_write=now
                if updates:
                    try: updates.put_nowait({'health':'캡처 대기 / 최소화 / 프레임 유실'})
                    except queue.Full: pass
                state.update(None,time.monotonic())
                for gate in expiry.values():gate.update(None,None,time.monotonic(),visible=False)
                time.sleep(.05);continue
            frame_id,stamp,image=item
            if frame_id==last_id:time.sleep(.01);continue
            last_id=frame_id;t=time.monotonic()
            if image.shape[:2]!=(768,1366):
                raise RuntimeError('현재 보정은 1366×768 전용입니다. 해상도 변경 후 재보정이 필요합니다.')
            exp=detect_exp(image,ocr)
            event=state.update(exp['value'],stamp)
            aux=auxiliaries.snapshot(time.monotonic())
            hud=aux.get('hud',{});lie=aux.get('lie',{})
            buff_result=aux.get('buffs',{}).get('buffs',[]);minimap=hud.get('minimap_bbox')
            events=['experience_stalled'] if event else []
            for kind,data in (('hud',hud),('lie',lie)):
                if not data or data.get('stamp')==processed.get(kind):continue
                processed[kind]=data['stamp']
                for key in ('rune','lie_detector'):
                    if key in data:
                        obs=data[key]
                        if gates[key].update(obs['present'] if obs['status']=='observed' else None,data['stamp']):events.append(key+'_appeared')
                if kind=='hud':
                    wealth=hud.get('wealth')
                    booster=hud.get('booster',{})
                    valid=minimap is not None and exp['valid']
                    if expiry['wealth'].update(wealth['remaining_seconds'] if wealth else None,
                        wealth['resolution_seconds'] if wealth else None,data['stamp'],
                        visible=valid and hud.get('buff_visibility')=='observable' and (wealth is None or wealth['remaining_seconds'] is not None)):
                        events.append('wealth_expired')
                    if expiry['booster'].update(booster.get('remaining_seconds'),1,data['stamp'],
                        visible=valid and booster.get('status')!='unknown'):events.append('booster_expired')
            report={'captured_at':time.strftime('%Y-%m-%d %H:%M:%S'),
                    'window':asdict(window),'health':'WGC 정상' if hud.get('buff_visibility')!='obscured' else 'WGC 정상 / 게임 내 툴팁으로 버프 영역 가림','frame_id':frame_id,
                    'minimap_bbox':minimap,'experience':exp,'experience_state':state.status,
                    'buff_count':len(buff_result) if buff_result and hud.get('buff_visibility')=='observable' else None,
                    'buff_visibility':hud.get('buff_visibility','unknown'),'buffs':buff_result,
                    'wealth':hud.get('wealth'),
                    'rune':hud.get('rune',{'status':'unknown'}),
                    'booster':hud.get('booster',{'status':'unknown'}),
                    'lie_detector':lie.get('lie_detector',{'status':'unknown'}),
                    'auxiliary_errors':{k:v['error'] for k,v in aux.items() if 'error' in v},
                    'auxiliary_processing_ms':{k:v.get('processing_ms') for k,v in aux.items()},
                    'lie_age_seconds':round(time.monotonic()-lie['stamp'],2) if 'stamp' in lie else None,
                    'hud_age_seconds':round(time.monotonic()-hud['stamp'],2) if 'stamp' in hud else None,
                    'last_alert':last_alert,
                    'processing_ms':round((time.monotonic()-t)*1000,2)}
            for event_type in events:
                event_data={'at':report['captured_at'],'type':event_type}
                last_alert=event_data;report['last_alert']=last_alert
                with (ROOT/'work/events.jsonl').open('a',encoding='utf-8') as f:f.write(json.dumps(event_data)+'\n')
                if sound:
                    import winsound
                    def beep(kind=event_type):
                        for _ in range(3 if kind=='lie_detector_appeared' else 2):
                            winsound.Beep(1500 if kind=='lie_detector_appeared' else 1100,180)
                            time.sleep(.12)
                    threading.Thread(target=beep,daemon=True).start()
            if stamp-last_write>=1:
                write_json(ROOT/'work/latest.json',report)
                last_write=stamp
            if updates:
                try:updates.put_nowait(report)
                except queue.Full:
                    try:updates.get_nowait()
                    except queue.Empty:pass
                    updates.put_nowait(report)
            frames+=1;times.append(report['processing_ms']);last_report=report
            if seconds is not None and time.monotonic()-start>seconds-.3:
                cv2.imwrite(str(ROOT/'work/latest_client.png'),image)
            time.sleep(max(0,.1-(time.monotonic()-t)))
    finally:
        auxiliaries.close()
        stream.stop()
    summary={'frames_analyzed':frames,'elapsed_seconds':round(time.monotonic()-start,2),
             'mean_processing_ms':round(sum(times)/len(times),2) if times else None,
             'latest':last_report}
    write_json(ROOT/'work/session.json',summary)
    return summary

def gui():
    import tkinter as tk
    from tkinter import ttk
    root=tk.Tk();root.title('Astra Test — 메이플스토리 화면 관측');root.geometry('930x600')
    root.configure(bg='#18222f')
    status=tk.StringVar(value='시작을 누르면 게임 창을 찾아 관측합니다.')
    exp=tk.StringVar(value='경험치: 대기');regions=tk.StringVar(value='영역: 대기')
    ttk.Label(root,textvariable=status,font=('Malgun Gothic',13)).pack(fill='x',padx=16,pady=12)
    ttk.Label(root,textvariable=exp,font=('Malgun Gothic',12)).pack(fill='x',padx=16)
    ttk.Label(root,textvariable=regions).pack(fill='x',padx=16,pady=8)
    columns=('id','name','time','raw','approval')
    tree=ttk.Treeview(root,columns=columns,show='headings',height=14)
    for col,label,width in zip(columns,['분류 ID','버프 이름','잔여시간','화면 숫자','확인 상태'],[90,220,200,100,160]):
        tree.heading(col,text=label);tree.column(col,width=width)
    tree.pack(fill='both',expand=True,padx=16,pady=10)
    notice=ttk.Label(root,text='룬 / 비약 / 부스터 / 거짓말 탐지기: 대기')
    notice.pack(padx=16,pady=5)
    controls=ttk.Frame(root);controls.pack(fill='x',padx=16,pady=12)
    sound=tk.BooleanVar(value=True)
    ttk.Checkbutton(controls,text='5가지 상황 소리 알림 (시작 시 적용)',variable=sound).pack(side='left')
    updates=queue.Queue(maxsize=2);stop=threading.Event();worker=None
    def start():
        nonlocal worker
        if worker and worker.is_alive():return
        stop.clear();enabled=sound.get();status.set('OCR 초기화 및 WGC 연결 중…')
        def work():
            try:run_observer(stop,updates,sound=enabled)
            except Exception as exc:
                try:updates.put_nowait({'health':str(exc)})
                except queue.Full:pass
        worker=threading.Thread(target=work,daemon=True);worker.start()
    ttk.Button(controls,text='감시 시작',command=start).pack(side='right',padx=5)
    ttk.Button(controls,text='중지',command=stop.set).pack(side='right')
    def poll():
        try:
            while True:
                r=updates.get_nowait();status.set(r['health'])
                if 'experience' not in r:
                    tree.delete(*tree.get_children());exp.set('경험치: 관측 불가');regions.set('영역: 관측 불가');notice.configure(text='감지 상태: 알 수 없음')
                    continue
                value=r['experience']['value'];exp.set(f"경험치: {value:,}" if value is not None else '경험치: 읽기 불확실')
                regions.set(f"미니맵 {r['minimap_bbox']} / 경험치 {r['experience']['bbox']} / 아이콘 {r['buff_count'] if r['buff_count'] is not None else '판독 불가'} / {r['experience_state']}")
                potion=r.get('wealth') or {}
                pn=potion.get('remaining_seconds')
                pt='?' if pn is None else f'{pn//60}분' if potion.get('resolution_seconds')==60 else f'{pn//60}:{pn%60:02}'
                notice.configure(text=f"룬: {r['rune'].get('present','?')} / 비약: {pt} / 부스터: {r['booster'].get('remaining_seconds','?')}초 / 탐지기: {r['lie_detector'].get('present','?')} / 최근 알림: {r.get('last_alert') or '없음'}")
                tree.delete(*tree.get_children())
                for b in r['buffs']:
                    n=b['remaining_seconds']
                    display=(f'{n//60}분' if b['resolution_seconds']==60 else f'{n//60}:{n%60:02}') if n is not None else ('스택 — 시간 아님' if b['time_mode']=='stack' else '표시 없음 / 미확인')
                    tree.insert('', 'end', values=(b['id'],b['name'] or '이름 미확인',display,b['raw_number'] or '—','확인됨' if b['approved'] else '사용자 확인 대기'))
        except queue.Empty:pass
        root.after(100,poll)
    def close():stop.set();root.destroy()
    root.protocol('WM_DELETE_WINDOW',close);poll();root.mainloop()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--headless',action='store_true');parser.add_argument('--seconds',type=float,default=10)
    parser.add_argument('--sound',action='store_true')
    args=parser.parse_args()
    (ROOT/'work').mkdir(exist_ok=True)
    if args.headless:print(json.dumps(run_observer(threading.Event(),seconds=args.seconds,sound=args.sound),ensure_ascii=False,indent=2))
    else:gui()

if __name__=='__main__':main()
