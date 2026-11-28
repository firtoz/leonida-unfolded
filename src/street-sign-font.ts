import { Archive, view } from "./archive";
import { joaat } from "./places";
import { readRpf9BootMember } from "./rpf9-boot";
import { openRpf9Preparer } from "./rpf9-prepare";
import { drawableNameKey } from "./street-drawable-identity";
import type { SignLabel } from "./street-placement";

const fontName="hgcpixymbols";
export const streetSignFontId=joaat(fontName);
export const streetSignFontPack="data/ttdb/graphics/ttdb_graphics.ttpf";
export const streetSignFontTexture="0x"+drawableNameKey(fontName);

type Glyph=[x:number,y:number,width:number,height:number,bearingX:number,bearingY:number,advance:number];
export type StreetSignFont={texture:string;width:number;height:number;glyphs:Map<number,Glyph>;kerning:Map<number,number>};
const pairKey=(left:number,right:number)=>left*0x110000+right;

export async function openStreetSignFont(file:Blob,executable:Blob):Promise<StreetSignFont>{
  const archive=new Archive("data.rpf",file);
  const prepare=await openRpf9Preparer(new Archive("executable",executable));
  const directory=await prepare(archive,0,file.size);
  const data=view(await readRpf9BootMember(archive,directory,"data/fonts/"+fontName,prepare.processMember));
  if(data.byteLength<0x70||data.getUint32(0)!==0x5053494e)
    throw new Error("Invalid sign font resource.");
  let start=0x40;
  const blocks=[0xac393bcc,0xd7e9c53b,0x8731ec16].map((type,index)=>{
    const row=8+index*16,length=data.getUint32(row+4,true),end=start+length;
    if(data.getUint32(row,true)!==type||data.getBigUint64(row+8)!==0xaaaaaaaaaaaaaaaan||
      end>data.byteLength||end>data.getUint32(4))throw new Error("Invalid sign font block.");
    const block={start,length};
    start=Math.ceil(end/16)*16;
    return block;
  });
  const [pairs,metrics,header]=blocks;
  if(header.length!==0x30||start!==data.getUint32(4))throw new Error("Invalid sign font header.");
  const width=data.getUint32(header.start+8,true),height=data.getUint32(header.start+12,true);
  if(!width||!height||width>2048||height>2048||metrics.length!==32*data.getUint32(header.start+16,true)||
    pairs.length!==12*data.getUint32(header.start+32,true))throw new Error("Invalid sign font dimensions.");
  const glyphs=new Map<number,Glyph>(),kerning=new Map<number,number>();
  for(let at=metrics.start;at<metrics.start+metrics.length;at+=32){
    const point=data.getUint32(at,true);
    const metric=Array.from({length:7},(_,i)=>data.getFloat32(at+4+i*4,true)) as Glyph;
    const [x,y,w,h,,,advance]=metric;
    if(point>=0x110000||glyphs.has(point)||!metric.every(Number.isFinite)||x<0||y<0||w<0||h<0||
      x+w>width||y+h>height||advance<0)throw new Error("Invalid sign glyph.");
    glyphs.set(point,metric);
  }
  for(let at=pairs.start;at<pairs.start+pairs.length;at+=12){
    const left=data.getUint32(at,true),right=data.getUint32(at+4,true),amount=data.getFloat32(at+8,true);
    if(left<0x110000&&right<0x110000&&Number.isFinite(amount))kerning.set(pairKey(left,right),amount);
  }
  return {texture:streetSignFontTexture,width,height,glyphs,kerning};
}

export function streetSignQuads(font:StreetSignFont,label:SignLabel,box:readonly [number,number,number,number]){
  if(label.font!==streetSignFontId)return;
  const points=Array.from(label.text,char=>char.codePointAt(0)!);
  const quads:{glyph:Glyph;pen:number}[]=[];
  let advance=0;
  for(const [i,point] of points.entries()){
    const glyph=font.glyphs.get(point);
    if(!glyph)return;
    if(point!==32)quads.push({glyph,pen:advance});
    advance+=glyph[6]+(font.kerning.get(pairKey(point,points[i+1]??0))??0);
  }
  const [left,top,right,bottom]=box;
  const scale=label.scale/font.width;
  const line=advance*scale,extent=label.width/label.lineScale;
  if(!quads.length||line<=0||line>extent||extent>right-left+.0001||label.anchor<top||label.anchor>bottom)return;
  const origin=left+(extent-line)*.5;
  // The vertical mode remains an approximation. Center the authored glyph
  // band inside the plate while retaining the measured horizontal layout.
  const lineHeight=Math.max(...quads.map(({glyph})=>glyph[3]))*scale;
  if(lineHeight>bottom-top)return;
  const v=top+Math.max(0,(bottom-top-lineHeight)*.5);
  return quads.map(({glyph:[x,y,w,h,bx,by],pen})=>({
    panel:[origin+(pen+bx)*scale,v+by*scale,origin+(pen+bx+w)*scale,v+(by+h)*scale] as const,
    atlas:[x/font.width,y/font.height,(x+w)/font.width,(y+h)/font.height] as const,
  }));
}
