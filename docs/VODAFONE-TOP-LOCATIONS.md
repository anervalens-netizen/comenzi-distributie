# Targeturi Vodafone pe punct de lucru

Coloana Target Vodafone din Prepay → Activări → Pe partener afișează valorile lunare importate din campania Top Locații. Codul de franciză din sursă este cheia. Pentru o selecție cu mai multe luni, fiecare target rămâne lângă luna lui.

Pregătește un fișier privat cu un rând pe franciză și lună. Prima linie a foii conține anteturile. Verifică legătura cu codul de franciză din CRM dacă sursa livrează un cod extern. Coloanele implicite sunt `Cod_Franciza` și `Target`. Pentru alte denumiri, folosește opțiunile `--point-column` și `--target-column`. Încarcă un bonus numai dintr-o coloană explicită cu număr de SIM-uri sau vouchere, prin `--bonus-units-column`.

```sh
node tools/import-vodafone-top-locations.mjs \
  --workbook /private/campaign.xlsx --sheet Targets --month YYYY-MM \
  --output /private/vodafone-top-locations-next.json
```

Opțiunea `--previous` păstrează celelalte luni din fișierul activ. Comanda creează un fișier nou și validează coloanele, valorile întregi și unicitatea francizei pe lună. Păstrează sursa și fișierul precedent privat. Publică fișierul nou prin redenumire atomică în același director, la calea setată prin `MOBIUP_VODAFONE_TOP_LOCATIONS` sau la `vodafone-top-locations.json` în `MOBIUP_DATA_DIR`.

Targetul și bonusul campaniei sunt valori distincte. Un bonus lipsă rămâne indisponibil până când există o valoare confirmată în unități. Dacă decontul exprimă premiul în lei, importă numai targetul. Coloana de bonus trebuie să indice SIM-uri, vouchere sau bucăți. Importatorul respinge sumele și procentele, inclusiv dacă sunt indicate prin formatul numeric al celulelor. Raportul SIM 0 folosește pragurile sale.
