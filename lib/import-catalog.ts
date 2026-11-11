export const importCatalog = [
 {id:'sales_agent',label:'Vânzări pe agent',extensions:['.xls','.xlsx'],max_bytes:8_000_000,requires_date_range:true},
 {id:'sales_location',label:'Vânzări pe locație',extensions:['.xlsx'],max_bytes:32*1024*1024,requires_date_range:true},
 {id:'stock_tr',label:'Stoc TR',extensions:['.xls','.xlsx'],max_bytes:8_000_000,requires_date_range:true},
 {id:'sim_sales_vodafone',label:'Vânzări SIM Vodafone',extensions:['.xlsx'],max_bytes:256*1024*1024,requires_date_range:true,requires_source_at:true},
 {id:'sim_sales_digi',label:'Vânzări SIM Digi',extensions:['.xlsx'],max_bytes:256*1024*1024,requires_date_range:true,requires_source_at:true},
 {id:'sim_activations_vodafone',label:'Activări SIM Vodafone',extensions:['.xlsx','.json.gz'],max_bytes:256*1024*1024,requires_date_range:true,requires_source_at:true},
 {id:'sim_activations_digi',label:'Activări SIM Digi',extensions:['.xlsx'],max_bytes:256*1024*1024,requires_date_range:true,requires_source_at:true,requires_company:true},
] as const;
