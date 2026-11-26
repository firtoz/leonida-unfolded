import { view, type Archive } from "./archive";
import { StreetRpf9, type StreetArchiveMember } from "./street-rpf9";

const navigationMemberType=0x4f;
const navigationVersion=0x10015;
type Cell=readonly [number,number];
type Run={members:StreetArchiveMember[];index:(x:number,y:number)=>number};

export class StreetNavCatalog {
  private readonly directory:StreetRpf9;
  private runs?:Promise<Run[]>;

  constructor(archive:Archive,executable:Blob){
    this.directory=new StreetRpf9(archive,executable);
  }

  private async cell(member:StreetArchiveMember):Promise<Cell> {
    const data=view(await this.directory.readSystem(member));
    if(data.byteLength<0xcc||data.getUint32(20,true)!==navigationVersion)
      throw new Error("Unsupported navigation cell header.");
    const area=data.getUint32(0xc8,true);
    return [area%512-256,Math.floor(area/512)-256];
  }

  private async discoverRun(members:StreetArchiveMember[]):Promise<Run|undefined> {
    if(members.length<4)return;
    const final=members.length-1,middle=Math.floor(final/2);
    const [first,last,mid]=await Promise.all([0,final,middle].map(i=>this.cell(members[i])));
    const dx=last[0]-first[0],width=(final-last[1]+first[1])/dx;
    if(dx<=0||!Number.isInteger(width)||width<=1||width>512)return;

    // The main world stores each run in increasing column order, then row
    // order. Locate the first column break and check the inferred run shape.
    let lower=1,upper=Math.min(final,width);
    while(lower<upper){
      const at=Math.floor((lower+upper)/2);
      const [col]=await this.cell(members[at]);
      if(col===first[0])lower=at+1;
      else upper=at;
    }
    const yMin=first[1]+lower-width;
    const index=(x:number,y:number)=>{
      if(y<yMin||y>=yMin+width)return -1;
      return (x-first[0])*width+y-first[1];
    };
    const [edge,wrap]=await Promise.all([lower-1,lower].map(i=>this.cell(members[i])));
    if(index(...last)!==final||index(...mid)!==middle||index(...edge)!==lower-1||index(...wrap)!==lower)return;
    return {members,index};
  }

  private async discover() {
    const mounts=new Map<number,StreetArchiveMember[]>();
    for await(const batch of this.directory.catalogMembers(undefined,new Set([navigationMemberType]))){
      for(const member of batch){
        const run=mounts.get(member.mountBase);
        if(run)run.push(member);
        else mounts.set(member.mountBase,[member]);
      }
    }
    const runs=await Promise.all([...mounts.values()].map(rows=>this.discoverRun(rows).catch(()=>undefined)));
    return runs.filter((run):run is Run=>run!==undefined);
  }

  async read(x:number,y:number){
    const runs=await (this.runs??=this.discover().catch(error=>{
      this.runs=undefined;
      throw error;
    }));
    for(const {members,index} of runs){
      const member=members[index(x,y)];
      if(!member)continue;
      const bytes=await this.directory.readSystem(member);
      const data=view(bytes);
      if(data.byteLength>=0xcc&&data.getUint32(20,true)===navigationVersion&&
        data.getUint32(0xc8,true)===(y+256)*512+x+256)return bytes;
    }
  }
}
