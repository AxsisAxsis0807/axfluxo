import type {Metadata,Viewport} from 'next';
import './globals.css';
export const metadata:Metadata={title:'AxFluxo — Visual Studio',description:'アイデアを、あなたの表現に。端末内で使えるビジュアル制作スタジオ。'};
export const viewport:Viewport={width:'device-width',initialScale:1,viewportFit:'cover',themeColor:'#101114'};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ja"><body>{children}</body></html>;}
