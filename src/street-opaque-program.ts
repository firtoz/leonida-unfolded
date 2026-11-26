type Arg=number|Iterable<number>;
type Slot={name:string;locations:(WebGLUniformLocation|null|undefined)[];apply?:(target:WebGLUniformLocation)=>void};
type Bridge={begin:()=>void;select:(vao:WebGLVertexArrayObject)=>void;end:()=>void;dispose:()=>void};
const bridges=new WeakMap<WebGL2RenderingContext,Bridge>();
const names=["uniform1i","uniform1f","uniform2f","uniform3f","uniform4f","uniform1iv","uniform3fv","uniform4fv","uniform4iv"] as const;
const vertices=new WeakMap<WebGLVertexArrayObject,Float32Array>();
const wet=new WeakMap<WebGLVertexArrayObject,boolean>();
export function registerOpaqueMesh(vao:WebGLVertexArrayObject,points:Float32Array){vertices.set(vao,points);}
function hasWater(vao:WebGLVertexArrayObject){
  let result=wet.get(vao);
  if(result!==undefined)return result;
  const points=vertices.get(vao);
  if(!points)return true;
  result=false;
  for(let offset=3;offset<points.length;offset+=4){
    if(points[offset]===67||points[offset]===71){result=true;break;}
  }
  wet.set(vao,result);
  return result;
}
export function install(gl:WebGL2RenderingContext,base:WebGLProgram,compile:(mode:number)=>WebGLProgram){
  if(bridges.has(gl))throw Error("Unexpected second main program");
  const rawUse=gl.useProgram.bind(gl),rawLocation=gl.getUniformLocation.bind(gl);
  const keys=["useProgram","getUniformLocation",...names] as const;
  const descriptors=keys.map(key=>Object.getOwnPropertyDescriptor(gl,key));
  const programs=[base];
  const slots=new Map<WebGLUniformLocation,Slot>();
  const dirty=[new Set<Slot>(),new Set<Slot>(),new Set<Slot>()];
  let active=-1,enabled=false;

  const location=(slot:Slot,mode:number)=>{
    if(slot.locations[mode]===undefined)slot.locations[mode]=rawLocation(programs[mode],slot.name);
    return slot.locations[mode];
  };
  function seedUniforms(program:WebGLProgram){
    const setters:Record<number,string>={
      [gl.FLOAT]:"uniform1f",[gl.FLOAT_VEC2]:"uniform2fv",[gl.FLOAT_VEC3]:"uniform3fv",[gl.FLOAT_VEC4]:"uniform4fv",
      [gl.INT]:"uniform1i",[gl.INT_VEC2]:"uniform2iv",[gl.INT_VEC3]:"uniform3iv",[gl.INT_VEC4]:"uniform4iv",
      [gl.BOOL]:"uniform1i",[gl.BOOL_VEC2]:"uniform2iv",[gl.BOOL_VEC3]:"uniform3iv",[gl.BOOL_VEC4]:"uniform4iv",
      [gl.UNSIGNED_INT]:"uniform1ui",
    };
    const prototype=WebGL2RenderingContext.prototype as unknown as Record<string,Function>;
    const count=gl.getProgramParameter(base,gl.ACTIVE_UNIFORMS) as number;
    for(let index=0;index<count;index++){
      const info=gl.getActiveUniform(base,index);
      if(!info)continue;
      for(let entry=0;entry<info.size;entry++){
        const name=info.size>1?info.name.replace("[0]","["+entry+"]"):info.name;
        const before=rawLocation(base,name),after=rawLocation(program,name);
        if(!before||!after)continue;
        const value=gl.getUniform(base,before);
        const raw=prototype[setters[info.type]??"uniform1i"];
        if(value!==null)Reflect.apply(raw,gl,[after,value]);
      }
    }
  }
  function activate(mode:number){
    if(mode===active)return;
    const newProgram=!programs[mode];
    const program=programs[mode]??=compile(mode);
    rawUse(program);active=mode;
    if(newProgram)seedUniforms(program);
    for(const slot of dirty[mode]){
      const target=location(slot,mode);
      if(target)slot.apply?.(target);
    }
    dirty[mode].clear();
  }

  gl.useProgram=(program)=>{
    if(program===base){activate(0);return;}
    rawUse(program);active=-1;
  };
  gl.getUniformLocation=(program,name)=>{
    const native=rawLocation(program,name);
    if(program===base&&native)slots.set(native,{name,locations:[native]});
    return native;
  };

  for(const method of names){
    const raw=gl[method].bind(gl) as (location:WebGLUniformLocation|null,...args:Arg[])=>void;
    const wrapped=(from:WebGLUniformLocation|null,...args:Arg[])=>{
      if(!from)return;
      const slot=slots.get(from);
      if(!slot||active<0){raw(from,...args);return;}
      const to=location(slot,active);
      if(to)raw(to,...args);
      // The viewer writes typed-array subviews that may be mutated after
      // gl.uniform returns, so save each call's values for the next program.
      const recorded=args.map(value=>typeof value==="number"?value:Array.from(value));
      slot.apply=target=>raw(target,...recorded);
      for(let mode=0;mode<dirty.length;mode++)if(mode!==active)dirty[mode].add(slot);
    };
    Object.defineProperty(gl,method,{configurable:true,value:wrapped});
  }

  bridges.set(gl,{
    begin(){enabled=true;},
    select(vao){if(enabled)activate(hasWater(vao)?1:2);},
    end(){if(enabled)activate(0);enabled=false;},
    dispose(){
      bridges.delete(gl);
      for(const program of programs.slice(1))if(program)gl.deleteProgram(program);
      keys.forEach((key,index)=>{
        const descriptor=descriptors[index];
        if(descriptor)Object.defineProperty(gl,key,descriptor);
        else Reflect.deleteProperty(gl,key);
      });
    }
  });
}
export function beginOpaque(gl:WebGL2RenderingContext){bridges.get(gl)?.begin();}
export function chooseOpaque(gl:WebGL2RenderingContext,vao:WebGLVertexArrayObject){bridges.get(gl)?.select(vao);}
export function endOpaque(gl:WebGL2RenderingContext){bridges.get(gl)?.end();}
export function disposeOpaque(gl:WebGL2RenderingContext){bridges.get(gl)?.dispose();}
