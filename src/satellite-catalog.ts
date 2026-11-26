import type { Archive, Range } from "./archive";
import { StreetRpf9 } from "./street-rpf9";

export async function catalogueSatelliteTerrain(levels:Archive,common:Archive,executable:Blob){
  const directory=new StreetRpf9(levels,executable);
  const {mounts}=await directory.levelMounts(common);
  const terrain=[...mounts.values()].filter(mount=>mount.path.startsWith("platform:/levels/americas/map/terrain/"));
  const drawables:Range[]=[],bounds:Range[]=[];
  for(let start=0;start<terrain.length;start+=8){
    const listings=await Promise.all(terrain.slice(start,start+8).map(mount=>directory.mountedMembers(mount)));
    for(const members of listings)for(const member of members){
      if(member.type===4){
        const stored=member.chunks?.[0];
        if(stored&&member.offset+stored<=member.end)drawables.push([member.offset,stored]);
      }else if(member.type===11){
        const offset=member.offset-16,stored=member.end-offset;
        if(stored>0&&stored<=65536)bounds.push([offset,stored]);
      }
    }
  }
  drawables.sort((a,b)=>a[0]-b[0]);
  bounds.sort((a,b)=>a[0]-b[0]);
  return {drawables,bounds};
}
