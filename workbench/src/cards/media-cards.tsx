import React from "react";
import { AbsoluteFill, Audio, Img, OffthreadVideo, staticFile } from "remotion";
import type { CardDef } from "./types";

declare global {
  interface Window { __shotcraftCloudMedia?: Record<string, string>; }
}
const mediaSrc = (file: string) => {
  if (typeof window !== "undefined" && window.__shotcraftCloudMedia?.[file]) return window.__shotcraftCloudMedia[file];
  return staticFile(file);
};

const VideoClip: React.FC<{file?:string;fit?:string;muted?:boolean;volume?:number;inOffset?:number;speed?:number}> =
  ({file="",fit="contain",muted=false,volume=1,inOffset=0,speed=1}) => !file ? null : (
    <AbsoluteFill style={{background:"#000"}}><OffthreadVideo src={mediaSrc(file)} trimBefore={Math.round(inOffset)} playbackRate={speed} muted={muted} volume={volume} style={{width:"100%",height:"100%",objectFit:fit as React.CSSProperties["objectFit"]}} /></AbsoluteFill>
  );
export const videoClipCard: CardDef = {
  id:"video-clip",name:"视频素材",category:"素材",kind:"video",timing:"realtime",durationInFrames:150,accent:"#30d158",
  component:VideoClip as React.ComponentType<Record<string,unknown>>,
  schema:[
    {type:"text",key:"file",label:"文件（public/ 或上传）",default:""},
    {type:"select",key:"fit",label:"适配",default:"contain",options:[{value:"contain",label:"完整显示"},{value:"cover",label:"铺满裁切"}]},
    {type:"boolean",key:"muted",label:"静音",default:false},
    {type:"slider",key:"volume",label:"音量",default:1,min:0,max:1,step:0.01},
  ],
};
const ImageClip: React.FC<{file?:string;fit?:string}> = ({file="",fit="contain"}) => !file ? null : (
  <AbsoluteFill style={{background:"#000"}}><Img src={mediaSrc(file)} style={{width:"100%",height:"100%",objectFit:fit as React.CSSProperties["objectFit"]}} /></AbsoluteFill>
);
export const imageClipCard: CardDef = {
  id:"image-clip",name:"图片素材",category:"素材",timing:"realtime",durationInFrames:90,accent:"#64d2ff",
  component:ImageClip as React.ComponentType<Record<string,unknown>>,
  schema:[{type:"text",key:"file",label:"文件（public/ 或上传）",default:""},{type:"select",key:"fit",label:"适配",default:"contain",options:[{value:"contain",label:"完整显示"},{value:"cover",label:"铺满裁切"}]}],
};
const AudioClip: React.FC<{file?:string;volume?:number;inOffset?:number;speed?:number}> = ({file="",volume=1,inOffset=0,speed=1}) => !file ? null : (
  <Audio src={mediaSrc(file)} volume={volume} trimBefore={Math.round(inOffset)} playbackRate={speed} />
);
export const audioClipCard: CardDef = {
  id:"audio-clip",name:"音频",category:"音频",kind:"audio",timing:"realtime",durationInFrames:90,accent:"#ff9f0a",
  component:AudioClip as React.ComponentType<Record<string,unknown>>,
  schema:[{type:"text",key:"file",label:"文件（public/ 或上传）",default:""},{type:"slider",key:"volume",label:"音量",default:1,min:0,max:1,step:0.01}],
};
