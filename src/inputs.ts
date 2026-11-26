import { inputProfile } from "./recover";
import { indexFileExtension, indexFileName } from "./street-index-bundle";
import { rpf9ExecutableName } from "./rpf9-prepare";
import { detailAtlasPackPath, imposterAtlasPackPath } from "./texture-pool-blocks";
export { rpf9ExecutableName };
const isIndex=(name:string)=>name.toLowerCase().endsWith(indexFileExtension);
const byName=new Map(inputProfile.map(item=>[item.path.split("/").at(-1)!.toLowerCase(),item]));
const streetPack=/^ttdb_(maps|props|interiors)(?:_\d+_\d+)?\.ttpf$/;
const namedPacks=new Map([imposterAtlasPackPath,detailAtlasPackPath].map(path=>[path.split("/").at(-1)!,path]));

export function accept(files:File[], destination:Record<string,File>) {
  for(const file of files){
    if(isIndex(file.name)){destination[indexFileName]=file;continue;}
    const name=file.name.toLowerCase(),spec=byName.get(name);
    if(name===rpf9ExecutableName){destination[name]=file;continue;}
    const pack=namedPacks.get(name);
    if(pack){destination[pack]=file;continue;}
    if(!spec){
      const category=streetPack.exec(name)?.[1];
      if(category)destination[`data/ttdb/${category}/${name}`]=file;
      continue;
    }
    if(destination[spec.path]?.size===spec.size&&file.size!==spec.size)continue;
    destination[spec.path]=file;
  }
}

export async function dropped(data:DataTransfer) {
  const pending=Array.from(data.items).flatMap(item=>{
    if(item.kind!=="file"||!item.webkitGetAsEntry)return [];
    const entry=item.webkitGetAsEntry();
    return entry?[entry]:[];
  });
  const files=Array.from(data.files);
  async function inspect(entry:FileSystemEntry,depth:number) {
    const name=entry.name.toLowerCase();
    if(entry.isFile&&(byName.has(name)||streetPack.test(name)||isIndex(name)||name===rpf9ExecutableName||namedPacks.has(name))){
      const file=await new Promise<File>((resolve,reject)=>(entry as FileSystemFileEntry).file(resolve,reject));
      files.push(file);
    }else if(entry.isDirectory&&depth<=6){
      const reader=(entry as FileSystemDirectoryEntry).createReader();
      for(;;){
        const children=await new Promise<FileSystemEntry[]>((resolve,reject)=>reader.readEntries(resolve,reject));
        if(!children.length)break;
        for(const child of children){
          if(child.isDirectory&&depth>1&&!["data","ttdb","terrain","maps","props","interiors","weapons","graphics"].includes(child.name.toLowerCase()))continue;
          await inspect(child,depth+1);
        }
      }
    }
  }
  for(const entry of pending)await inspect(entry,0);
  return files;
}
