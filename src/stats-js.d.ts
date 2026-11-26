declare module "stats.js" {
  export default class Stats {
    static Panel: new (name:string,foreground:string,background:string)=> {
      dom:HTMLCanvasElement;
      update(value:number,maximum:number):void;
    };
  }
}
