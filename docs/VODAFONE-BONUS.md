# Registrul de bonusuri Vodafone

Managerii cu acces la Activări găsesc **Bonusuri Vodafone** în secțiunea Activări. Registrul grupează activările pe lună și franciză și păstrează contribuțiile pe gestiune. Excelul poate fi descărcat pe lună sau pentru toată perioada de la iunie 2026.

Registrul folosește proiectele, regiunea, agentul și luna selectate. La prima deschidere afișează primele 50 de rânduri din fiecare vedere. Căutarea după partener, franciză, CUI, TR sau număr de document și butonul „Arată încă” consultă lista completă. Dacă ai introdus un text de căutare, exporturile includ toate rândurile care corespund căutării, inclusiv pe cele din afara primei pagini. Foaia „Luni” păstrează acoperirea întregului portofoliu selectat.

Pentru 3–4 activări SIM 0 premiul calculat este un SIM 5. Pentru 5–9 se calculează două. De la 10 se adaugă câte cinci pentru fiecare grup complet de 10 activări. O franciză deservită de mai multe gestiuni are un singur prag. Managerul care are acces la o parte dintre gestiuni vede contribuțiile disponibile și un indicator de acoperire. Activările fără franciză univocă sunt în **De identificat**.

Sunt eligibile documentele complete cu SIM 5 și vouchere Vodafone la preț și valoare zero, reconciliate în exporturile pe client și pe gestiune. Conturile generice și mișcările tehnice identificate sunt excluse. Documentele mixte, retururile și diferențele dintre surse rămân vizibile pentru reconciliere. Stingerile merg către cea mai veche lună eligibilă a aceleiași francize și păstrează numărul facturii, data și luna dreptului.

## Vânzări către persoane fizice

În rapoartele de activări și vânzări, codurile ERP `CLIENTGEN` și `GENERICPARTENER` reprezintă vânzări către persoane fizice. Aceste vânzări nu necesită cod de punct de lucru. În „Pe partener” apar separat și sunt excluse din numărul de puncte comerciale și din clasamentele partenerilor.

În Focus, o activare generică eligibilă pentru totalul regional contribuie și la „Realizare TR” numai dacă județul activării figurează între județele alocate agentului. Cu județ lipsă sau atribuit altui agent, activarea rămâne doar în regional. Ecranul, detaliul și exportul Excel folosesc aceeași atribuire. Pentru o firmă cu mai multe puncte, identificarea CUI-ului singur nu stabilește magazinul.

## Publicarea și dovada fiscală

O lună are raport final când o sursă Vodafone acoperă întreaga lună și are dată de publicare în luna următoare sau mai târziu. Perioadele fără raport final au valori de calcul provizorii. Soldul confirmat cere dovada fiscală a documentelor și un premiu Top Locații stabilit pentru punct și lună. Documentele fără tip fiscal pot contribui la simularea SIM 0 după reconcilierea surselor. În această simulare soldul de deschidere la 1 iunie este zero. O perioadă anterioară fără raport final, cu activări atribuite neconfirmate fiscal sau fără decont Top Locații pe punct păstrează soldul lunilor următoare neconfirmat. Un bonus zero explicit în decont confirmă că punctul nu are drepturi Top Locații pentru luna respectivă.

Când sursa principală fiscală există în afara exporturilor, operatorul poate înregistra dovezile exacte în cheia privată `vodafone-bonus-evidence-v1` din configurația aplicației. Cheia are câmpurile `published` și `documents`. Intrările trebuie susținute de o referință de audit în câmpul `evidence`. Un document de acordare este legat prin emitent, data documentului, SiteId ERP și numărul facturii. În cazul activărilor, emitentul și SiteId se citesc din mișcarea de distribuție. O etichetă explicită de bon de consum sau reglare de gestiune din sursă exclude documentul.

Exemplul folosește identificatori fictivi.

```json
{
  "published": [
    { "month": "2026-06", "date": "2026-07-03", "evidence": "Sursa finală Vodafone arhivată" }
  ],
  "documents": [
    {
      "source": "sales",
      "company": "Example ERP",
      "date": "2026-07-14",
      "site": "SAMPLE-SITE",
      "number": "SAMPLE-1",
      "kind": "commercial",
      "evidence": "Factura fiscală verificată"
    }
  ]
}
```

Sunt acceptate `source=activation` și `source=sales`, cu `kind=commercial` ori `kind=excluded`. Configurația trebuie păstrată în mediul privat. Rapoartele sunt derivate din versiunile active ale surselor. Corecțiile și înlocuirile de import recalculează alocările și păstrează luna activărilor și data documentului ca date distincte.

## Pregătirea registrului după import

Workerul din release acceptă comanda `node --max-old-space-size=192 --max-semi-space-size=8 ./vodafone-bonus-worker.mjs --warm-ledger`. Citește configurația instalată și pregătește registrul comun tuturor gestiunilor. Rezultatul `current` confirmă că fișierul existent a trecut verificările. Rezultatul `rebuilt` confirmă că workerul a publicat o copie nouă. Jurnalul conține starea și durata.

Unitățile `deploy/mobiup-vodafone-bonus-warmup.service` și `.timer` pornesc verificarea după boot și la două minute după ultima execuție. La instalare folosește contul aplicației, executabilul Node, release-ul și directoarele de date ale serviciului web. Transmite și `MOBIUP_VODAFONE_TOP_LOCATIONS` dacă aplicația folosește un fișier personalizat. Creează directorul `.vodafone-bonus-cache` în directorul de date cu proprietarul aplicației și modul `0700`. Setează `ReadWritePaths` la acel director, apoi activează timerul cu `systemctl enable --now mobiup-vodafone-bonus-warmup.timer`. O execuție manuală a serviciului după import sau după activarea unui release reduce intervalul până la prima citire rapidă.

## Acces la surse și actualizarea registrului

La actualizarea unei instalări existente, operatorul poate aplica indexurile de factură și produse gratuite prin `python3 tools/client_sales_history.py --database /cale/configurată/client-history/client-sales-history.sqlite --ensure-schema`. Aceeași schemă se aplică la importurile următoare. După prima actualizare de schemă, reconstruiește proiecția de activitate din aceeași sursă cu procedura din [client-sales.md](client-sales.md). Repetarea comenzii păstrează indexurile existente.

Registrul păstrează o copie derivată privată în `.vodafone-bonus-cache/current.bin` din directorul de date. Refolosirea cere aceeași versiune de worker, aceleași surse și aceleași reguli. Accesul și gestiunile vizibile se verifică pentru fiecare solicitare. O copie absentă sau deteriorată se reconstruiește automat. Într-un director fără drept de scriere aplicația folosește memoria procesului.
