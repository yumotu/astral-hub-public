import { useEffect, useRef } from 'react';
import { Brain, Check, ChevronDown } from 'lucide-react';
import './thinking-control.css';
const levels = [
  {value:'off',label:'关闭',description:'直接回答，适合简单问题'},
  {value:'low',label:'轻量',description:'简短思考，优先响应速度'},
  {value:'high',label:'深入',description:'分析复杂问题和多步任务'},
  {value:'max',label:'充分',description:'使用模型支持的最高思考强度'},
] as const;
type ThinkingLevel = typeof levels[number]['value'];
export function ThinkingControl({value,disabled,onChange}:{
  value:ThinkingLevel; disabled?:boolean; onChange:(value:ThinkingLevel)=>void;
}) {
  const ref=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const close=(e:PointerEvent)=>{if(ref.current&&!ref.current.contains(e.target as Node))ref.current.open=false;};
    const key=(e:KeyboardEvent)=>{if(e.key==='Escape'&&ref.current?.open){e.stopPropagation();ref.current.open=false;ref.current.querySelector('summary')?.focus();}};
    document.addEventListener('pointerdown',close);document.addEventListener('keydown',key);
    return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',key);};
  },[]);
  useEffect(()=>{if(disabled&&ref.current)ref.current.open=false;},[disabled]);
  return <details className={`thinking-picker ${value!=='off'?'is-active':''}`} ref={ref}>
    <summary aria-label={`思考强度：${levels.find(l=>l.value===value)?.label}`} aria-disabled={disabled||undefined}
      onClick={e=>{if(disabled)e.preventDefault();}}>
      <Brain size={15}/><span>思考</span><b>{levels.find(l=>l.value===value)?.label}</b><ChevronDown size={11}/>
    </summary>
    <div className="thinking-picker-options" role="radiogroup" aria-label="思考强度">
      <strong>思考强度</strong>
      {levels.map(level=><button type="button" role="radio" aria-checked={value===level.value} key={level.value}
        disabled={disabled} onClick={()=>{onChange(level.value);if(ref.current)ref.current.open=false;}}>
        <span><b>{level.label}</b><small>{level.description}</small></span>
        {value===level.value&&<Check size={15}/>}
      </button>)}
    </div>
  </details>;
}
