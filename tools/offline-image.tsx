import type { ImgHTMLAttributes } from 'react';
// Offline entry has no framework image loader; all existing images are unoptimized.
// eslint-disable-next-line next/no-img-element
export default function Image({unoptimized:_unoptimized,priority:_priority,...props}:ImgHTMLAttributes<HTMLImageElement>&{unoptimized?:boolean;priority?:boolean}){return <img {...props} alt={props.alt||''}/>;}
