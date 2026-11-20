# Registrul de bonusuri Vodafone

Managerii cu acces la Activări găsesc **Bonusuri Vodafone** în secțiunea Activări. Registrul grupează activările pe lună și franciză și păstrează contribuțiile pe gestiune. Excelul poate fi descărcat pe lună sau pentru toată perioada de la iunie 2026.

Pentru 3–4 activări SIM 0 premiul calculat este un SIM 5. Pentru 5–9 se calculează două. De la 10 se adaugă câte cinci pentru fiecare grup complet de 10 activări. O franciză deservită de mai multe gestiuni are un singur prag. Managerul care are acces la o parte dintre gestiuni vede contribuțiile disponibile și un indicator de acoperire. Activările fără franciză univocă sunt în **De identificat**.

Sunt eligibile documentele complete cu SIM 5 și vouchere Vodafone la preț și valoare zero, reconciliate în exporturile pe client și pe gestiune. Conturile generice și mișcările tehnice identificate sunt excluse. Documentele mixte, retururile și diferențele dintre surse rămân vizibile pentru reconciliere. Stingerile merg către cea mai veche lună eligibilă a aceleiași francize și păstrează numărul facturii, data și luna dreptului.

## Publicarea și dovada fiscală

O lună are raport final când o sursă Vodafone acoperă întreaga lună și are dată de publicare în luna următoare sau mai târziu. Perioadele fără raport final au valori de calcul provizorii. Soldul confirmat cere dovada fiscală a documentelor și un premiu Top Locații stabilit pentru punct și lună. Documentele fără tip fiscal pot contribui la simularea SIM 0 după reconcilierea surselor. În această simulare soldul de deschidere la 1 iunie este zero.

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
