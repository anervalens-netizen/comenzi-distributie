import type {PartnerMapData,MapBounds} from './partner-map-types';
/** Fixed world Mercator grid; all features/counts are preserved. At detail zoom coincident points remain individually selectable. */
export function aggregateMapPoints(data:PartnerMapData,zoom:number):PartnerMapData{
 if(!Number.isInteger(zoom)||zoom<0||zoom>22)throw new Error('Invalid zoom');
 if(zoom>=17)return {...data,serverAggregated:true,zoom,totalPoints:data.features.length};
 const buckets=new Map<string,{features:PartnerMapData['features'];bounds:MapBounds;lng:number;lat:number}>();const cells=2**zoom*4;
 for(const f of data.features){const [lng,lat]=f.geometry.coordinates;const clamped=Math.max(-85.051129,Math.min(85.051129,lat));const sin=Math.sin(clamped*Math.PI/180);const x=Math.floor((lng+180)/360*cells),y=Math.floor((.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*cells);const key=x+':'+y;let b=buckets.get(key);if(!b){b={features:[],bounds:[lng,lat,lng,lat],lng:0,lat:0};buckets.set(key,b);}b.features.push(f);b.lng+=lng;b.lat+=lat;b.bounds=[Math.min(b.bounds[0],lng),Math.min(b.bounds[1],lat),Math.max(b.bounds[2],lng),Math.max(b.bounds[3],lat)];}
 const features:PartnerMapData['features']=[];for(const [key,b] of buckets){const n=b.features.length;if(n===1){features.push(b.features[0]);continue;}features.push({type:'Feature',id:'grid:'+zoom+':'+key,geometry:{type:'Point',coordinates:[b.lng/n,b.lat/n]},properties:{id:'grid:'+zoom+':'+key,name:n+' puncte',approximate:b.features.some(f=>f.properties.approximate),cluster:true,point_count:n,point_count_abbreviated:n>=1000?String(Math.round(n/100)/10)+'k':String(n),expansionZoom:zoom+1,bounds:b.bounds}});}
 return {type:'FeatureCollection',serverAggregated:true,zoom,totalPoints:data.features.length,features};
}
