const size=128;

// A periodic height field with independent phases. Keep longer waves
// directionally aligned and allow short ripples to mingle across them.
function waveSlopes(){
  const tau=Math.PI*2;
  const east=new Float32Array(size*size),north=new Float32Array(size*size);
  let seed=0x5f8276a3;
  const random=()=>{
    seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;
    return (seed>>>0)/4294967296;
  };
  const used=new Set<string>();
  for(let i=0;i<36;i++){
    const short=i>=12;
    const angle=.34+(random()-.5)*(short?2.9:1.2);
    const frequency=(short?6:1.9)+random()*(short?18:6.5);
    const x=Math.round(Math.cos(angle)*frequency),y=Math.round(Math.sin(angle)*frequency);
    const key=x+","+y;
    if(used.has(key))continue;
    used.add(key);
    const length=Math.hypot(x,y),phase=random()*tau;
    const noise=(.50+.5*random())/Math.sqrt(length);
    const dx=x/length*noise,dy=y/length*noise;
    const cos=new Float32Array(size),sin=new Float32Array(size);
    for(let col=0;col<size;col++){
      const turn=phase+tau*col*x/size;
      cos[col]=Math.cos(turn);sin[col]=Math.sin(turn);
    }
    for(let row=0;row<size;row++){
      const turn=tau*row*y/size,c=Math.cos(turn),s=Math.sin(turn),base=row*size;
      for(let col=0;col<size;col++){
        const gradient=c*cos[col]-s*sin[col];
        east[base+col]+=gradient*dx;
        north[base+col]+=gradient*dy;
      }
    }
  }
  let energy=0;
  for(let at=0;at<east.length;at++)energy+=east[at]**2+north[at]**2;
  const gain=44/Math.sqrt(energy/east.length);
  const output=new Uint8Array(east.length*2);
  for(let at=0;at<east.length;at++){
    output[at*2]=Math.max(0,Math.min(255,Math.round(128+east[at]*gain)));
    output[at*2+1]=Math.max(0,Math.min(255,Math.round(128+north[at]*gain)));
  }
  return output;
}

export function createStreetWaveTexture(gl:WebGL2RenderingContext){
  const texture=gl.createTexture();
  if(!texture)return;
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RG8,size,size,0,gl.RG,gl.UNSIGNED_BYTE,waveSlopes());
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.REPEAT);
  gl.generateMipmap(gl.TEXTURE_2D);
  return texture;
}
