// ==================== BloodOra Backend - Canonical Reference Content ====================
// This module is the *guaranteed* source of the site's reference material.
// Admin-managed database rows are MERGED on top of it (see routes/meta.js), so a
// reference page can never render empty because the database is fresh, empty,
// unreachable or still seeding. Every field is bilingual-ready.

// ------------------------------------------------------------------ Anti-D
// Anti-D (RhD immunoglobulin) — complete clinical reference.
export const antidReference = {
  updated: "2026",
  summary: {
    en: "Anti-D Immunoglobulin (RhIg) is a sterile solution of human IgG antibodies against the RhD antigen. It is given to RhD-negative women so their immune system never becomes sensitised to RhD-positive fetal red cells, preventing Haemolytic Disease of the Fetus and Newborn (HDFN) in the current and every future pregnancy.",
    bn: "অ্যান্টি-ডি ইমিউনোগ্লোবুলিন (RhIg) হলো RhD অ্যান্টিজেনের বিরুদ্ধে মানব IgG অ্যান্টিবডির একটি দ্রবণ। Rh-নেগেটিভ মায়েদের এটি দেওয়া হয় যাতে তাদের শরীর Rh-পজিটিভ ভ্রূণের লোহিত রক্তকণিকার প্রতি সংবেদনশীল না হয়ে ওঠে — ফলে বর্তমান ও ভবিষ্যতের প্রতিটি গর্ভাবস্থায় HDFN প্রতিরোধ হয়।",
    ar: "الغلوبولين المناعي المضاد لـ D هو محلول معقّم من الأجسام المضادة البشرية IgG ضد مستضد RhD. يُعطى للنساء سالبات Rh حتى لا يتحسس جهازهن المناعي ضد كريات الدم الحمراء الجنينية موجبة Rh، مما يمنع انحلال دم الجنين وحديثي الولادة.",
  },
  whatItIs: [
    {
      title: "What Anti-D actually is",
      body: "Anti-D Immunoglobulin is purified human IgG anti-RhD, manufactured from the plasma of donors who have been deliberately immunised against the RhD antigen. It is a passive immunisation: the antibodies are supplied ready-made, they do not teach the mother's immune system anything, and they clear any RhD-positive red cells from her circulation before her own immune system can mount a memory response.",
    },
    {
      title: "Why it is needed — the Rh problem",
      body: "About 15% of people are RhD-negative. When an RhD-negative mother carries an RhD-positive baby, a small fetomaternal haemorrhage during pregnancy or delivery can push fetal red cells into the maternal circulation. Without Anti-D, roughly 16% of these women will become sensitised: they make permanent anti-D antibodies. Those antibodies cross the placenta in the NEXT pregnancy and destroy the baby's red cells — causing anaemia, hydrops fetalis, kernicterus or stillbirth.",
    },
    {
      title: "What sensitisation causes",
      body: "Haemolytic Disease of the Fetus and Newborn (HDFN). Severity ranges from mild neonatal jaundice needing phototherapy to severe anaemia requiring intrauterine transfusion, to fetal death. Because maternal antibodies persist for life, the risk increases with every subsequent RhD-positive pregnancy. Routine Anti-D prophylaxis has cut the incidence of anti-D alloimmunisation by more than 90%.",
    },
  ],
  indications: [
    { condition: "Routine antenatal prophylaxis", who: "Every RhD-negative pregnant woman, whether or not any bleeding has occurred", when: "28 weeks (single dose) or 28 + 34 weeks (two-dose schedule)", note: "Covers the third-trimester silent fetomaternal haemorrhage." },
    { condition: "Within 72 hours of delivery", who: "RhD-negative mother of an RhD-positive (or unknown) newborn", when: "As soon as possible, ideally ≤72 hours after birth", note: "Dose adjusted by Kleihauer-Betke / flow-cytometry FMH volume." },
    { condition: "Miscarriage, threatened or complete", who: "RhD-negative woman, ≥12 weeks gestation (or any gestation with surgical evacuation)", when: "Immediately at presentation", note: "Before 12 weeks a smaller 50–120 mcg dose is acceptable where available." },
    { condition: "Ectopic pregnancy / molar pregnancy", who: "All RhD-negative women", when: "At diagnosis or after treatment", note: "Trophoblastic tissue expresses RhD." },
    { condition: "Termination of pregnancy", who: "All RhD-negative women, any gestation", when: "Same day as the procedure", note: "Dose scales with gestational age." },
    { condition: "Invasive prenatal procedures", who: "Amniocentesis, CVS, fetal blood sampling, external cephalic version, abdominal trauma", when: "Within 72 hours of the event", note: "Repeat dosing every 6 weeks if procedures are repeated." },
    { condition: "Antepartum haemorrhage", who: "Any bleeding episode in an RhD-negative pregnancy", when: "Within 72 hours of each episode, repeated every 6 weeks if bleeding continues", note: "Do not wait for delivery." },
    { condition: "Transfusion of RhD-positive blood", who: "RhD-negative girl or woman of childbearing potential wrongly transfused RhD-positive red cells or platelets", when: "Immediately on discovery", note: "≈20 mcg per mL of RhD-positive red cells; large volumes may need exchange transfusion." },
  ],
  dosing: [
    { scenario: "Antenatal prophylaxis (28 weeks)", dose: "1500 IU (300 mcg) IM", route: "Intramuscular, deltoid or anterolateral thigh", repeat: "Single dose; or 500 IU at 28 and 34 weeks in the two-dose schedule" },
    { scenario: "Postnatal prophylaxis, standard FMH < 4 mL fetal red cells", dose: "1500 IU (300 mcg) IM", route: "Intramuscular", repeat: "Once, within 72 hours of birth" },
    { scenario: "Large fetomaternal haemorrhage", dose: "Add 125 IU per extra 1 mL of fetal red cells above 4 mL", route: "IM (IV formulations where licensed)", repeat: "Guided by Kleihauer-Betke test at 48–72 hours postpartum" },
    { scenario: "First-trimester event (< 12 weeks)", dose: "50–120 mcg (250–600 IU)", route: "Intramuscular", repeat: "Once" },
    { scenario: "Events from 12 weeks onwards", dose: "300 mcg (1500 IU)", route: "Intramuscular", repeat: "Once per event" },
    { scenario: "Wrong-blood-group transfusion", dose: "≈20 mcg (100 IU) per 1 mL of RhD-positive red cells", route: "Divided IM/IV over days", repeat: "Until the transfused RhD-positive cells are cleared" },
  ],
  timing: [
    { milestone: "Booking visit", action: "Group and RhD type + antibody screen on every pregnant woman." },
    { milestone: "28 weeks", action: "Give routine antenatal Anti-D to all RhD-negative women. Repeat antibody screen." },
    { milestone: "Any sensitising event", action: "Give Anti-D within 72 hours — never assume an event is 'too small'." },
    { milestone: "Delivery", action: "Cord blood group & direct antiglobulin test. Give Anti-D within 72 hours if baby is RhD-positive or unknown." },
    { milestone: "48–72 hours postpartum", action: "Kleihauer-Betke / flow cytometry to quantify FMH; top-up dose if needed." },
    { milestone: "After a missed dose", action: "Give it anyway — partial protection persists up to 28 days, though 72 hours remains the target." },
  ],
  administration: [
    "Check maternal blood group, RhD type and current antibody screen before every dose.",
    "If anti-D is ALREADY present in the maternal plasma as an immune antibody, Anti-D prophylaxis is useless — refer to obstetric medicine for fetal surveillance.",
    "Deep intramuscular injection into the deltoid (or anterolateral thigh in small adults). Aspirate before injecting.",
    "Never mix Anti-D with other drugs or vaccines in the same syringe. It may be given at a different site on the same day as routine vaccines, including live vaccines.",
    "Observe the patient for 20 minutes afterwards — anaphylaxis is rare but possible in IgA-deficient recipients.",
    "Record the batch number, dose and date in the antenatal record and give the patient a card.",
    "A Kleihauer-Betke acid-elution test at 48–72 hours detects under-dosing; flow cytometry is preferred where available.",
  ],
  safety: {
    common: [
      "Pain, tenderness, redness or a small lump at the injection site (most frequent complaint)",
      "Low-grade fever, headache, malaise, mild chills",
      "Transient skin rash or itching",
    ],
    rare: [
      "Anaphylaxis or anaphylactoid reaction — especially in IgA-deficient patients with anti-IgA antibodies",
      "Urticaria, arthralgia, myalgia several days after injection",
      "Very rarely, disseminated intravascular coagulation in patients receiving large IV doses for wrong-blood-group transfusion",
    ],
    contraindications: [
      "Known hypersensitivity to human immunoglobulin preparations or to any excipient (e.g. glycine, polysorbate 80)",
      "RhD-positive women and RhD-negative women already alloimmunised to RhD (no benefit)",
      "Severe thrombocytopenia or coagulopathy — prefer an IV formulation over intramuscular injection",
      "IgA deficiency with documented anti-IgA antibodies — use an IgA-depleted product or avoid",
    ],
    storage: [
      "Store at 2 °C to 8 °C. DO NOT FREEZE — a frozen vial must be discarded.",
      "Protect from light in the original carton.",
      "After reconstitution use immediately; some products allow up to 4 hours at 2–8 °C.",
      "The cold chain is the single most common cause of Anti-D failure in district-level practice in Bangladesh — verify the vaccine-carrier temperature log before injecting.",
    ],
  },
  faq: [
    { q: "I already received Anti-D at 28 weeks. Do I still need it after delivery?", a: "Yes. The antenatal dose only protects the weeks it was given for. A separate postnatal dose within 72 hours of birth is required whenever the baby is RhD-positive or the baby's group is unknown." },
    { q: "My husband is RhD-negative too. Do I still need Anti-D?", a: "If paternity is certain and the father is truly RhD-negative, the fetus will be RhD-negative and prophylaxis is unnecessary. In practice most guidelines still recommend it unless the father's group is confirmed, because a single missed dose risks every future pregnancy." },
    { q: "It has been more than 72 hours. Is it too late?", a: "Give it anyway. Protection declines but does not vanish — evidence supports benefit up to 28 days after the event. Do not withhold a late dose." },
    { q: "Does Anti-D harm the baby?", a: "No. Anti-D does not cross into the fetus in a clinically meaningful amount and has an excellent safety record over five decades of use. The small amount that does cross can cause a weakly positive direct antiglobulin test in the newborn, which is harmless." },
    { q: "Can Anti-D be given with other vaccines?", a: "Yes, including live attenuated vaccines. Use a separate syringe and a separate injection site. Rubella vaccine given postpartum alongside Anti-D is standard practice." },
    { q: "Where can I get it in Bangladesh?", a: "Anti-D is available in most district and upazila health complexes and in private hospitals. BloodOra's medical shop lists Rhophylac Anti-D 300 mcg under the Medicine category; you can order it for ৳10 delivery inside Kalai Upazila." },
  ],
  sources: [
    "ACOG Practice Bulletin No. 181 — Prevention of Rh D Alloimmunization",
    "RCOG Green-top Guideline No. 65 — The Management of Rhesus Isoimmunisation in Pregnancy",
    "WHO Recommendations on Antenatal Care for a Positive Pregnancy Experience",
    "Bangladesh National Guideline on Maternal & Neonatal Care, DGHS",
  ],
};

// ------------------------------------------------------------- Compatibility
export const compatibilityReference = {
  // Red-cell (packed RBC) compatibility — donor group -> recipients
  rbc: [
    { group: "O−", donatesTo: "O−, O+, A−, A+, B−, B+, AB−, AB+", receivesFrom: "O−", donorType: "Universal red-cell donor", recipientType: "Can receive only O−", note: "The emergency choice when a patient's group is unknown. In women of childbearing potential, always prefer group-specific O− and never give RhD-positive red cells." },
    { group: "O+", donatesTo: "O+, A+, B+, AB+", receivesFrom: "O−, O+", donorType: "Most commonly available donor in Bangladesh", recipientType: "RhD-positive only", note: "Approximately 35% of Bangladeshis are O+." },
    { group: "A−", donatesTo: "A−, A+, AB−, AB+", receivesFrom: "O−, A−", donorType: "Rare and highly valuable", recipientType: "A− or O−", note: "Only about 1% of the population." },
    { group: "A+", donatesTo: "A+, AB+", receivesFrom: "O−, O+, A−, A+", donorType: "Common", recipientType: "A and O groups", note: "Approximately 28% of Bangladeshis." },
    { group: "B−", donatesTo: "B−, B+, AB−, AB+", receivesFrom: "O−, B−", donorType: "Uncommon, always needed", recipientType: "B− or O−", note: "Frequent target of urgent appeals." },
    { group: "B+", donatesTo: "B+, AB+", receivesFrom: "O−, O+, B−, B+", donorType: "Very common in South Asia", recipientType: "B and O groups", note: "Approximately 25% of Bangladeshis." },
    { group: "AB−", donatesTo: "AB−, AB+", receivesFrom: "O−, A−, B−, AB−", donorType: "Rarest of all groups (< 1%)", recipientType: "All RhD-negative groups", note: "Universal plasma donor as well — see the plasma table." },
    { group: "AB+", donatesTo: "AB+ only", receivesFrom: "O−, O+, A−, A+, B−, B+, AB−, AB+", donorType: "Donates red cells only to AB+", recipientType: "Universal red-cell recipient", note: "Can receive red cells from anyone, but AB+ red cells help almost no one else." },
  ],
  plasma: [
    { group: "AB", compatible: "A, B, AB and O recipients", role: "Universal plasma donor", note: "AB plasma contains no anti-A or anti-B, so it is the emergency plasma of choice. Because AB donors are rare, most blood banks now use pathogen-reduced group-A plasma for emergencies." },
    { group: "A", compatible: "A and AB recipients", role: "Commonly used substitute for AB", note: "Low-titre anti-B makes it acceptable in most emergency protocols." },
    { group: "B", compatible: "B and AB recipients", role: "Group-specific use", note: "Contains anti-A." },
    { group: "O", compatible: "O recipients only (group-specific transfusion)", role: "Group-specific", note: "Contains both anti-A and anti-B — the mirror image of red-cell compatibility." },
  ],
  platelets: [
    { point: "ABO preference, not absolute", detail: "Platelets carry only weak ABO antigens. Group-identical platelets are preferred, but ABO-mismatched platelets are acceptable when they are the only option." },
    { point: "Plasma volume matters", detail: "The incompatible part is the donor plasma. Use platelet concentrates with reduced plasma volume, or wash them, for major mismatches." },
    { point: "RhD still matters", detail: "RhD-negative women of childbearing potential receiving RhD-positive platelets should be given Anti-D, because of contaminating red cells." },
    { point: "Never cold-stored casually", detail: "Platelets are stored at 20–24 °C with continuous agitation for only 5 days, so supply is chronically short — register as a platelet donor on BloodOra if you can." },
  ],
  components: [
    { component: "Whole blood", storage: "2–6 °C", shelfLife: "35 days (CPDA-1)", used: "Rarely used today; exchanged for component therapy in acute massive haemorrhage." },
    { component: "Packed red cells (PRBC)", storage: "2–6 °C", shelfLife: "35–42 days depending on additive", used: "Anaemia, acute blood loss, thalassaemia, sickle cell disease, surgery." },
    { component: "Fresh frozen plasma (FFP)", storage: "−25 °C or below", shelfLife: "12 months (24 h after thawing at 1–6 °C)", used: "Coagulopathy, massive transfusion, warfarin reversal, TTP." },
    { component: "Cryoprecipitate", storage: "−25 °C or below", shelfLife: "12 months", used: "Fibrinogen deficiency, von Willebrand disease, haemophilia A, DIC." },
    { component: "Platelet concentrate", storage: "20–24 °C with agitation", shelfLife: "5 days", used: "Thrombocytopenia, dengue, chemotherapy, haematological malignancy." },
  ],
  emergencies: [
    { rule: "Unknown group, life-threatening bleed", action: "Give O− red cells. In men and postmenopausal women O+ may be used when O− is exhausted." },
    { rule: "Always cross-match", action: "A type-and-crossmatch takes 45 minutes. In an emergency, give group-specific uncrossmatched blood and send the cross-match in parallel." },
    { rule: "The RhD rule for women", action: "Never give RhD-positive red cells to a girl or woman of childbearing potential unless there is no alternative — and give Anti-D if you must." },
    { rule: "Massive transfusion", action: "Use a 1:1:1 ratio of red cells : plasma : platelets, warm the blood, monitor ionised calcium and potassium." },
    { rule: "Transfusion reactions", action: "Stop the transfusion immediately, keep IV access with saline, check the patient identity and unit labels, and send the unit plus a fresh sample to the blood bank." },
  ],
  facts: [
    "One whole-blood donation is separated into red cells, plasma and platelets — it can help up to three different patients.",
    "Red cells survive about 120 days in the body; a healthy donor can donate again after 8 weeks (men) or 12 weeks (women).",
    "Platelet donors can donate every 2 weeks, up to 24 times a year.",
    "A single dengue patient may need 10–20 units of platelets.",
    "O− red cells and AB plasma are the two most chronically scarce products in Bangladesh — both depend on a tiny donor pool.",
    "The rarest blood group in the world is Rh-null (‘golden blood’), documented in fewer than 50 people worldwide.",
  ],
};

// ---------------------------------------------------------------- Resources
// Each resource is a full article, not a teaser.
export const resourcesReference = [
  {
    title: "Who can donate blood? The complete eligibility checklist",
    category: "Donation",
    readTime: "4 min",
    summary: "Age, weight, haemoglobin, intervals and the medical conditions that permanently or temporarily defer a donor.",
    content: "In Bangladesh a voluntary donor must be 18–60 years old, weigh at least 50 kg, and have a haemoglobin of at least 12.5 g/dL. You must not have donated whole blood in the last 8 weeks (men) or 12 weeks (women). Permanent deferral applies to anyone with hepatitis B or C, HIV, HTLV, Chagas disease, variant CJD risk, or a history of cancer treated with chemotherapy. Temporary deferral applies after a tattoo or piercing (12 months), dental extraction (72 hours), minor surgery (6 months), live-virus vaccination (4 weeks), pregnancy (throughout, plus 6 weeks after delivery or miscarriage), a fever or antibiotic course (7 days after finishing), and travel to a malaria-endemic area (12 months). Blood pressure should be 100–180 systolic and 50–100 diastolic, pulse 50–100/min and regular.",
  },
  {
    title: "What happens on the day you donate — step by step",
    category: "Donation",
    readTime: "3 min",
    summary: "Registration, screening, the 8–10 minute draw, and the 15-minute recovery that protects you.",
    content: "Registration takes 5 minutes: identity, contact details and consent. Screening follows — a short medical history, blood pressure, pulse, temperature and a finger-prick haemoglobin. The draw itself takes 8–10 minutes for 450 mL into a citrate anticoagulant bag; you will feel a brief sting and nothing more. Afterwards you rest for 15 minutes with fluids and biscuits. Keep the pressure dressing on for 4–6 hours, drink an extra litre of fluid that day, avoid heavy lifting or strenuous exercise for 24 hours, and eat normally. Total time in the centre: about 30–45 minutes. The donated unit is then tested for HIV, HBsAg, anti-HCV, VDRL, malaria antigen and ABO/RhD grouping before release.",
  },
  {
    title: "Preparing for donation: food, water and the night before",
    category: "Donation",
    readTime: "3 min",
    summary: "How to avoid the faint, the bruise and the low-iron deferral.",
    content: "Sleep 6–8 hours the night before. Never donate on an empty stomach — eat a normal meal 2–3 hours beforehand, because donors who eat first are far less likely to feel faint. Drink 500 mL of water in the hour before donation; this alone measurably reduces vasovagal reactions. Avoid fatty food immediately before, as lipaemic plasma can make the unit unusable. Avoid alcohol for 24 hours before and after. Iron-rich foods in the weeks before donation — liver, red meat, lentils, spinach, fortified cereals, plus vitamin C to boost absorption — reduce the chance of a low-haemoglobin deferral. Wear a shirt with sleeves that roll above the elbow.",
  },
  {
    title: "After donating: side effects, recovery and red flags",
    category: "Donation",
    readTime: "3 min",
    summary: "The normal reactions, how to manage them, and the two symptoms that need medical attention.",
    content: "Most donors feel completely normal. The common reactions are a bruise at the needle site (apply a cold pack for 15 minutes, then warmth), light-headedness for a few minutes, and fatigue for the rest of the day. If you feel faint, lie down and raise your legs, or sit with your head between your knees; apply applied-tension — crossing the legs and tensing the thigh and abdominal muscles — to abort a vasovagal episode. Seek medical attention if the needle site keeps bleeding after 15 minutes of firm pressure, if numbness or shooting pain radiates down the arm (possible nerve irritation), or if you develop fever and spreading redness at the site within a few days.",
  },
  {
    title: "Blood groups and inheritance: where your group comes from",
    category: "Education",
    readTime: "4 min",
    summary: "ABO alleles, the RhD gene, the Punnett square, and why an O+ couple can have an O− child.",
    content: "ABO blood group is controlled by one gene with three alleles: A and B are codominant, O is recessive. Your genotype determines the antigens on your red cells: AA or AO expresses A, BB or BO expresses B, AB expresses both, and OO expresses neither. RhD is a separate gene where D is dominant over d. This is why two A+ parents can have an O− child: both are AO and Dd, so a quarter of their children inherit O from each parent and d from each parent. Antigen frequencies differ by population — in Bangladesh roughly 33% are O+, 28% A+, 25% B+, 12% AB+, and only about 7% of the population is RhD-negative, which is why RhD-negative donors are always urgently needed.",
  },
  {
    title: "Understanding the blood test report before transfusion",
    category: "Education",
    readTime: "4 min",
    summary: "ABO/RhD grouping, antibody screen, cross-match and the direct antiglobulin test explained.",
    content: "Forward grouping mixes your red cells with known anti-A and anti-B sera; reverse grouping mixes your plasma with known A and B red cells. The two must agree — a discrepancy is the most common cause of a delayed blood-bank report. RhD typing uses anti-D reagent; a weak reaction may indicate the weak-D variant, which requires indirect antiglobulin testing. The antibody screen detects unexpected red-cell antibodies (anti-Kell, anti-E, anti-c and so on) that can cause delayed haemolytic reactions. The cross-match is the final safety step: donor red cells are mixed with the recipient's plasma and must show no agglutination. The direct antiglobulin test (Coombs) checks whether antibodies are already coating the patient's own red cells — it is positive in autoimmune haemolytic anaemia and in HDFN.",
  },
  {
    title: "First aid for severe bleeding while you wait for blood",
    category: "First-Aid",
    readTime: "5 min",
    summary: "Direct pressure, elevation, tourniquets and shock positioning — what actually saves the patient before transfusion.",
    content: "The single most effective action is firm, continuous direct pressure on the wound with a clean cloth — do not remove a soaked dressing, add another layer on top. Raise the injured limb above heart level if no fracture is suspected. For life-threatening limb bleeding that does not respond to pressure, apply a commercial tourniquet 5–7 cm above the wound, never over a joint, tighten until bleeding stops, and write down the time; do not loosen it. Lay the patient flat with the legs elevated 30 cm, keep them warm with a blanket, and give nothing to drink if surgery may be needed. Watch for shock: pale cold clammy skin, rapid weak pulse, rapid breathing, restlessness and confusion. Call for emergency help and post the request on BloodOra at the same time — the average response for an urgent request is under 30 minutes.",
  },
  {
    title: "Dengue and platelets: what the count really means",
    category: "First-Aid",
    readTime: "4 min",
    summary: "When platelet transfusion genuinely helps in dengue, and why the number alone should not trigger it.",
    content: "A falling platelet count is expected in dengue and by itself is not an indication to transfuse. Transfusion is indicated for significant bleeding — gastrointestinal, mucosal or intracranial — regardless of the count, and is considered prophylactically only below 10,000–20,000/µL with additional risk factors. The mainstay of dengue management is careful fluid management: isotonic crystalloid titrated to the haematocrit and urine output, with strict avoidance of over-hydration, which causes pulmonary oedema. Because platelets are stored at room temperature for only 5 days, dengue season creates acute shortages — a single patient may need 10–20 units. Register as a platelet donor on BloodOra before the season peaks.",
  },
  {
    title: "Nutrition for donors: rebuilding iron after a donation",
    category: "Health",
    readTime: "4 min",
    summary: "Foods, absorption enhancers and blockers, and when an iron supplement is appropriate.",
    content: "One 450 mL donation removes roughly 200–250 mg of iron, and the body needs 4–8 weeks to replace it from diet alone. Excellent sources are beef liver (6 mg per 100 g), red meat, chicken, fish, lentils (3.3 mg per 100 g), chickpeas, tofu, pumpkin seeds, dark leafy greens and iron-fortified cereals. Absorption improves dramatically with vitamin C — add lemon, guava, amloki or orange to the meal. Absorption is blocked by tea and coffee (tannins), calcium-rich dairy taken at the same meal, and some antacids; keep these at least an hour away from your iron-rich meal. Frequent donors, menstruating women and vegetarians should ask for a low-dose daily or alternate-day iron supplement — alternate-day dosing actually absorbs better than daily dosing because it avoids the hepcidin rebound.",
  },
  {
    title: "Thalassaemia in Bangladesh: carrier screening before marriage",
    category: "Health",
    readTime: "5 min",
    summary: "Why premarital Hb electrophoresis matters, and the transfusion burden of thalassaemia major.",
    content: "Bangladesh has an estimated 10–12% carrier rate for thalassaemia traits. When two carriers marry, each pregnancy carries a 25% chance of thalassaemia major, a lifelong disease requiring transfusion every 3–4 weeks from infancy plus iron chelation therapy to prevent cardiac and endocrine damage. A single simple test — haemoglobin electrophoresis or HPLC, costing only a few hundred taka — identifies carriers before marriage. Two carriers can still marry and have healthy children with prenatal diagnosis in the first trimester. Because thalassaemia patients consume a large and permanent share of the blood supply, every voluntary donor directly supports them. If you or your partner have a family history of unexplained anaemia or transfusion dependence, get screened — and register as a regular donor on BloodOra.",
  },
  {
    title: "Blood safety: how every donated unit is screened",
    category: "Education",
    readTime: "3 min",
    summary: "The mandatory tests, the window period, and what screening can and cannot guarantee.",
    content: "Every donated unit in Bangladesh is mandatorily tested for HIV-1 and HIV-2 antibodies/antigen, hepatitis B surface antigen, hepatitis C antibody, syphilis (VDRL/RPR) and malaria antigen, alongside ABO and RhD grouping. Nucleic-acid testing (NAT), where available, shortens the window period dramatically: from about 22 days for HIV antibody testing to roughly 10 days, and from 70 to 20 days for hepatitis C. The residual window period is the reason screening can never be a substitute for honest donor history — always answer the screening questionnaire truthfully. Leucodepletion, pathogen-reduction technology and irradiation are additional layers used for immunocompromised recipients.",
  },
  {
    title: "Organ and marrow donation: the other ways to save a life",
    category: "Health",
    readTime: "4 min",
    summary: "Bone marrow, cord blood, kidney and cornea donation — eligibility and how to register.",
    content: "A living kidney donor can lead a completely normal life with the remaining kidney and is the best source for a transplant recipient. Bone marrow or peripheral blood stem cell donation treats leukaemia, aplastic anaemia and thalassaemia major; a matched unrelated donor is found through HLA typing, and collection is now usually by apheresis rather than a marrow harvest. Umbilical cord blood, collected painlessly after delivery, is a rich source of stem cells and is wasted in almost every birth in Bangladesh. Cornea donation after death can restore sight to two people and requires only the family's consent within 6 hours. Registering as a voluntary blood donor on BloodOra is the fastest way to be reachable for all of these.",
  },
];

// ------------------------------------------------------- Site route map (AI)
// Every public route on the site, with what it does. Used to build the AI
// knowledge base and to turn "open the shop" into a real clickable link.
export const siteRoutes = [
  { path: "/", title: "Home", purpose: "Landing page: live activity feed, verified-donor count, urgent cases, recent donors, how-it-works steps and the shop teaser.", keywords: ["home", "landing", "start", "main page", "হোম"] },
  { path: "/donors", title: "Donor Directory", purpose: "Search the verified donor network by blood group, district, upazila and minimum age. Shows donor cards with contact links.", keywords: ["donor", "find donor", "search donor", "blood group search", "দাতা"] },
  { path: "/donors/profile/my", title: "My Profile", purpose: "Logged-in user's own profile: blood group, location, donation availability toggle, verification status and verification request.", keywords: ["my profile", "profile", "my account", "availability"] },
  { path: "/donors/profile/edit", title: "Edit Profile", purpose: "Update name, phone, holding address, date of birth (age is recalculated automatically) and profile photo.", keywords: ["edit profile", "update profile", "change photo", "date of birth"] },
  { path: "/blood-requests", title: "Blood Requests", purpose: "Browse all open blood requests, filter by blood group, district and urgency, and mark a request as fulfilled.", keywords: ["blood request", "requests", "browse requests", "urgent list"] },
  { path: "/request-blood", title: "Request Blood", purpose: "Post a new blood request: patient details, blood group, quantity, hospital, contact, needed-by date and an urgent flag with reason.", keywords: ["request blood", "post request", "need blood", "urgent request", "রক্ত"] },
  { path: "/urgent", title: "Urgent Appeal Form", purpose: "Dedicated rapid appeal form for life-threatening emergencies — routed with the urgent flag set.", keywords: ["urgent", "emergency", "appeal"] },
  { path: "/shop", title: "Medical Shop", purpose: "Browse and filter the medical shop catalogue: medicines, supplements, equipment and healthcare products, with category filter, search, stock and add-to-cart.", keywords: ["shop", "store", "medicine", "buy", "products", "দোকান", "catalogue"] },
  { path: "/shop/cart", title: "Shopping Cart", purpose: "Review cart items, change quantities, remove items and see the subtotal before checkout.", keywords: ["cart", "basket", "cart items"] },
  { path: "/shop/checkout", title: "Checkout", purpose: "Choose payment method (bKash, Nagad, Upay, Rocket, Pathao, Card or Cash on Delivery), enter the transaction ID and the delivery address. Delivery is only available in Kalai Upazila for ৳10.", keywords: ["checkout", "payment", "order", "bkash", "nagad", "delivery", "address"] },
  { path: "/shop/my-orders", title: "My Orders", purpose: "Order history with status (pending, processing, shipped, delivered, cancelled), payment status and totals.", keywords: ["my orders", "order history", "track order", "order status"] },
  { path: "/reviews", title: "Reviews & Testimonials", purpose: "Public review page: star-rated product reviews for shop items plus general BloodOra testimonials, with an average-rating summary and a submission form for logged-in users.", keywords: ["review", "reviews", "rating", "testimonial", "feedback", "stars", "রিভিউ"] },
  { path: "/compatibility", title: "Blood Compatibility", purpose: "Complete ABO/RhD reference: red-cell donor and recipient matrix, plasma compatibility, platelet rules, component storage and shelf life, emergency transfusion rules and blood-group facts.", keywords: ["compatibility", "blood group chart", "donate to", "receive from", "universal donor", "universal recipient", "plasma", "platelet"] },
  { path: "/antid", title: "Anti-D Information", purpose: "Full clinical reference on Anti-D Immunoglobulin (RhIg): what it is, why RhD-negative mothers need it, every indication, the dosing schedule, administration technique, side effects, contraindications, cold-chain storage and FAQs.", keywords: ["anti-d", "antid", "rhd", "immunoglobulin", "rh negative", "pregnancy", "hdfn", "এন্টি-ডি"] },
  { path: "/resources", title: "Educational Resources", purpose: "Article library: donor eligibility, what happens on donation day, preparation, recovery, blood-group genetics, transfusion testing, first aid for bleeding, dengue platelets, donor nutrition, thalassaemia screening, blood safety and organ/marrow donation.", keywords: ["resources", "education", "articles", "learn", "guide", "resources page"] },
  { path: "/donation-guidelines", title: "Donation Guidelines", purpose: "Official eligibility rules, deferral periods, donation intervals and the voluntary-donor code of conduct.", keywords: ["guidelines", "eligibility", "rules", "deferral"] },
  { path: "/faq", title: "FAQ", purpose: "Frequently asked questions about donating, requesting blood, verification, the shop, delivery, payment and accounts.", keywords: ["faq", "questions", "help", "common questions"] },
  { path: "/contact", title: "Contact Us", purpose: "Site email, phone, address, social links and the contact message form.", keywords: ["contact", "support", "reach us", "address", "phone", "email"] },
  { path: "/login", title: "Login", purpose: "Sign in with email and password. Returns a JWT session valid for 7 days.", keywords: ["login", "sign in", "log in", "account access"] },
  { path: "/register", title: "Register", purpose: "Create an account: name, email, phone, password, blood group, division/district/upazila and date of birth. Donors must be 18+.", keywords: ["register", "sign up", "create account", "new account"] },
  { path: "/messages", title: "Messages", purpose: "User messaging centre: inbox, sent items, unread count, send a message to the admin team or to another user, and reply.", keywords: ["messages", "inbox", "message admin", "send message", "reply"] },
  { path: "/messages/send", title: "Send Message", purpose: "Compose a message to the BloodOra admin team or to another registered user by email.", keywords: ["send message", "compose", "write message"] },
  { path: "/admin", title: "Admin Dashboard", purpose: "Admin control centre: live stats (users, verified donors, orders, products, pending verifications, urgent requests), the site notice broadcaster, user management (verify, promote, demote, edit, delete, impersonate) and admin creation.", keywords: ["admin", "dashboard", "control panel", "stats", "users", "notice"] },
  { path: "/admin/settings", title: "Site Settings", purpose: "Manage the site name, tagline, contact details, description, social links and all payment gateway merchant numbers.", keywords: ["settings", "site settings", "social links", "payment gateway", "merchant number"] },
  { path: "/admin/branding", title: "Branding & Identity", purpose: "Upload the site logo and favicon, set the display name, tagline, primary and accent brand colours and the calligraphic heading style. Changes apply across the whole site instantly.", keywords: ["branding", "logo", "favicon", "site name", "colors", "theme", "identity"] },
  { path: "/admin/smtp", title: "SMTP & Email", purpose: "Full mail-server configuration: host, port, TLS/SSL, username, password, from-name and from-address, plus a one-click test email and the outgoing email log.", keywords: ["smtp", "email", "mail server", "send email", "mail log", "nodemailer"] },
  { path: "/admin/ai", title: "AI Assistant", purpose: "Configure the Live AI Help: enable/disable, Groq API key, model selection (default qwen/qwen3.6-27b), temperature, max tokens, the custom system persona, suggested prompts, and a live connection test.", keywords: ["ai", "assistant", "groq", "qwen", "chatbot", "live ai help", "model"] },
  { path: "/admin/content", title: "Content Manager", purpose: "Create, edit, feature and delete Anti-D reference entries and educational resources, with category, summary, body, image and featured flag.", keywords: ["content", "antid entries", "resources editor", "articles", "cms"] },
  { path: "/admin/reviews", title: "Review Moderation", purpose: "Approve, reject, feature, reply to and delete product reviews and testimonials.", keywords: ["reviews moderation", "approve review", "moderate", "reply review"] },
  { path: "/admin/live-chat", title: "Live Chat Inbox", purpose: "Real-time support inbox: every live conversation across the site, streamed updates, reply directly into the visitor's chat widget, and hand the conversation to the AI or back to a human.", keywords: ["live chat", "support inbox", "conversations", "live messaging"] },
  { path: "/shop/admin/products", title: "Product Management", purpose: "Shop administration: list all products including unavailable ones, add a product with image, price, category and stock, edit any field, toggle availability and delete.", keywords: ["products", "manage products", "add product", "stock", "shop admin"] },
  { path: "/shop/admin/orders", title: "Order Management", purpose: "Filter orders by status, open any order, confirm payment, change fulfilment status and generate the printable invoice.", keywords: ["orders", "manage orders", "confirm payment", "invoice", "order status"] },
  { path: "/health", title: "Health Check", purpose: "Proxies the backend health endpoint: database connectivity, service name and timestamp.", keywords: ["health", "status", "uptime"] },
  { path: "/sitemap.xml", title: "Sitemap", purpose: "XML sitemap of the public pages for search engines.", keywords: ["sitemap", "seo"] },
];

// ------------------------------------------------------- Feature knowledge
// A-to-Z description of what the platform can do, used by the AI assistant.
export const featureKnowledge = [
  {
    area: "Donor Network",
    details: "Voluntary donors register, then an admin verifies them. Verified donors appear in the public directory at /donors and can be filtered by blood group (all 8 ABO/RhD groups), division, district, upazila and minimum age. Each donor card links to a public profile at /donors/profile/view/:id. A donor can toggle their own availability on and off at /donors/profile/my at any time, and can request verification once they are 18 or older.",
  },
  {
    area: "Blood Requests",
    details: "Anyone can post a request at /request-blood with patient name and relation, blood group, quantity, hospital name and address, contact person, phone, optional email, needed-by date, division/district/upazila and an urgent flag with a reason. The urgent appeal shortcut is /urgent. All open requests are listed at /blood-requests with filters, and each request has a detail page at /blood-request/:id where a donor can mark it fulfilled or cancelled. Unfulfilled urgent requests are surfaced on the homepage.",
  },
  {
    area: "Medical Shop",
    details: "The shop at /shop sells medicines, supplements, equipment and healthcare products. The catalogue supports a category filter and free-text search, and each card shows the live stock count. Clicking a card opens the product detail page at /shop/product/:id. Add to cart is instant and works without an account; the cart lives in the browser session and is priced by the server. The cart page /shop/cart lets the user change quantity or remove items. Checkout at /shop/checkout requires login, supports bKash, Nagad, Upay, Rocket, Pathao, Card and Cash on Delivery, asks for the payment transaction ID, and stores the payment number on the user's profile for next time. Home delivery is available ONLY in Kalai Upazila for a flat ৳10. After ordering, the user sees a confirmation page and can track the order at /shop/my-orders with statuses pending, processing, shipped, delivered and cancelled.",
  },
  {
    area: "Reviews & Testimonials",
    details: "The review page at /reviews shows two kinds of feedback: 1–5 star reviews attached to specific shop products, and general testimonials about BloodOra itself. Reviews can be filtered by product, by star rating and by type, and the page shows the overall average rating and total count. Logged-in users submit a review with a rating, title and body; if the review is attached to a product the user must have ordered it. New reviews go to the admin moderation queue and only appear publicly once approved. Admins can approve, reject, feature and publicly reply to any review, and can delete it.",
  },
  {
    area: "Live Activity",
    details: "The homepage Live Activity panel is real, not decorative. It streams genuine events from the database over a server-sent-event endpoint at /api/meta/activity/stream with a polling fallback at /api/meta/activity: newly verified donors, new blood requests, urgent appeals raised, requests fulfilled, new shop orders, orders delivered, new approved reviews and new user registrations, each with a relative timestamp and a deep link to the relevant page. The feed is shared across all visitors, so it updates in real time for everyone.",
  },
  {
    area: "Live Messaging & Live AI Help",
    details: "Two floating widgets sit at the bottom right of every page. (1) Live Messaging connects a visitor to a real human: messages are persisted in the database, streamed to the admin inbox at /admin/live-chat in real time, and admin replies appear in the visitor's widget live. Guests can chat without an account; logged-in users are identified by name. (2) Live AI Help is a Qwen-powered assistant with full knowledge of the site — every page, feature, workflow and option — and it returns clickable links, so asking it to open a page gives a working hyperlink. It also answers the three supported languages and can hand off to a human. The separate Messages centre at /messages is the asynchronous mailbox for longer conversations with the admin team or another user.",
  },
  {
    area: "Multilingual Support",
    details: "A language toggle in the top navigation switches the whole interface between English (en), Bengali (bn) and Arabic (ar). The choice is stored in the browser cookie and the server session, so it persists across pages and visits. Arabic switches the layout to full right-to-left, and the typography swaps to a script-appropriate font for each language. All UI labels, navigation, buttons, forms, error pages and the AI assistant's replies follow the selected language.",
  },
  {
    area: "Admin Panel",
    details: "Admins sign in at /login and reach the dashboard at /admin. Super admins are provisioned from environment variables and can do everything an admin can plus promote, demote, edit, delete and impersonate users. The dashboard shows live counts of users, verified donors, orders (with pending), products, pending verifications and urgent requests, and hosts the site-notice broadcaster. Sub-sections: /admin/settings (contact details, description, socials, payment merchant numbers), /admin/branding (logo, favicon, site name, tagline, brand colours, heading style), /admin/smtp (full mail server configuration plus test send and email log), /admin/ai (Groq key, model, temperature, system persona, suggested prompts, connection test), /admin/content (Anti-D entries and educational resources CRUD), /admin/reviews (moderation), /admin/live-chat (real-time support inbox), /shop/admin/products and /shop/admin/orders (shop management with printable invoices).",
  },
  {
    area: "Accounts & Security",
    details: "Registration at /register requires name, email, phone, a password of at least 6 characters, blood group and location. Login issues a JSON Web Token valid for 7 days, held in an httpOnly server session cookie on the frontend. Single-session enforcement means a new login revokes the previous token. Passwords are stored as bcrypt hashes. Uploaded images are proxied through the frontend from the backend's upload storage. Admins can impersonate any non-super-admin user and switch back; impersonation revokes the target's session when it ends.",
  },
  {
    area: "Business & Operational Rules",
    details: "Home delivery is restricted to Kalai Upazila, Joypurhat, for a flat ৳10 charge — the checkout rejects any other upazila. Donors must be at least 18 years old to be verified. Payment confirmation is manual: an admin confirms the transaction at /shop/admin/orders, which moves the order to processing and generates the invoice. Orders decrement product stock atomically at creation. Out-of-stock and unavailable products cannot be added to the cart. The site notice, when set by an admin, appears as a banner on the homepage.",
  },
];

// --------------------------------------------------------- Business rules
export const businessRules = [
  "Home delivery is ONLY available in Kalai Upazila (Joypurhat district) and costs a flat ৳10. Checkout rejects any other upazila.",
  "Donors must be at least 18 years old to be verified as donors.",
  "An order can only be placed by a logged-in user; browsing and adding to the cart work without an account.",
  "Payment confirmation is manual: an admin confirms the mobile-banking transaction ID, which moves the order to 'processing'.",
  "Order statuses are: pending, processing, shipped, delivered, cancelled. Payment status is: pending or confirmed.",
  "Supported payment methods: bKash, Nagad, Upay, Rocket, Pathao, Card, and Cash on Delivery.",
  "New reviews and testimonials are moderated by an admin before they appear publicly.",
  "The Live AI Help is powered by Qwen3.6 27B served through Groq and can be reconfigured or disabled from /admin/ai.",
  "The site supports three languages: English, Bengali (বাংলা) and Arabic (العربية), switchable from the top navigation.",
];
