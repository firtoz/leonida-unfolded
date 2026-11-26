type LoadingStatus = { detail?:string; done?:number; total?:number; paused?:boolean };
type Row = {
  element:HTMLLIElement;
  detail:HTMLSpanElement;
  bar:HTMLProgressElement;
  delay?:number;
};

export class LoadingOverlay {
  private readonly rows=new Map<string,Row>();

  constructor(private readonly panel:HTMLElement,private readonly list:HTMLElement){}

  attach(parent:HTMLElement){parent.append(this.panel);}

  set(key:string,label:string,{detail="",done,total,paused=false}:LoadingStatus={}){
    let row=this.rows.get(key);
    if(!row){
      const element=document.createElement("li"),status=document.createElement("div");
      const title=document.createElement("span"),value=document.createElement("span");
      const bar=document.createElement("progress");
      title.textContent=label;
      bar.setAttribute("aria-label",label);
      status.append(title,value);
      element.append(status,bar);
      row={element,detail:value,bar};
      this.rows.set(key,row);
      const current=row;
      current.delay=window.setTimeout(()=>{
        this.list.append(current.element);
        this.panel.hidden=false;
      },180);
    }
    row.detail.textContent=detail;
    row.element.classList.toggle("paused",paused);
    if(done!==undefined&&total!==undefined&&total>0){
      row.bar.max=total;
      row.bar.value=done;
    }else row.bar.removeAttribute("value");
  }

  clear(...keys:string[]){
    for(const key of keys){
      const row=this.rows.get(key);
      if(!row)continue;
      window.clearTimeout(row.delay);
      row.element.remove();
      this.rows.delete(key);
    }
    this.panel.hidden=!this.list.childElementCount;
  }

  reset(){this.clear(...this.rows.keys());}
}
