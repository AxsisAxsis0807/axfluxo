import {families} from '../domain/text';
export async function loadFonts(){await Promise.all(Object.values(families).flatMap(f=>['400','700'].map(async weight=>{const faces=await document.fonts.load(`${weight} 32px "${f}"`,'日本語Aa');if(!faces.length||faces.some(f=>f.status!=='loaded'))throw new Error('フォント読込失敗。再読み込みしてください。');})));await document.fonts.ready;}
