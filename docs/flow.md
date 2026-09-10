# flow.md — job_pipeline

Raw flow пайплайну подачі на вакансії, зафіксований після обговорення. Терміни — див. `brief.md#Glossary`. Незалежний проект (не залежить від даних/трекера `career/job_search`, хоч і зʼявився як результат роботи з ним).

## Команда запуску

```
apply <N> <source> [--method api|browser|auto] [--channel <rating|name>]
```

- `N` (submission batch) — обов'язковий, без дефолту: користувач завжди задає кількість подач за цей запуск.
- `source` — у v1 єдине валідне значення `linkedin` (інші майданчики — out of scope, див. `brief.md`).
- `--method` — опціональний, дефолт `auto` (API-first, fallback на browser automation). Впливає лише на Stage 1.
- `--channel` — опціональний, дефолт відсутній (без фільтра). Мінімальний прийнятний apply-channel rating (0–4, див. Stage 3) або назва каналу (напр. `meet-the-hiring-team`). Фраза користувача на кшталт «10 максимально робочих» — це природномовний спосіб виразити `--channel 4`; скіл/команда мусить вміти розпізнати такий інтент при парсингу запиту, а не вимагати від користувача завжди писати прапорець вручну.

Реалізується як окремий скіл/команда (назва/деталі імплементації — TBD, поза межами цього документа; тут фіксується лише поведінка пайплайну).

## Пайплайн

### Stage 0 — Onboarding gate
**Тригер:** кожен виклик `apply`, до будь-якої іншої стадії.
**Дія:** перевірка (не сам онбординг!) — чи `base_cv.md` і `user_info.md` існують і закривають мінімально необхідний набір полів (canonical schema — спільна з `onboarding.md` Stage O1, точний список TBD там).
**Якщо gate не пройдено:** `apply` одразу зупиняється, жодна стадія 1–8 не стартує. Користувачу повідомляється, що спершу треба виконати окрему команду `onboard` (див. `onboarding.md`) — `apply` **не** запускає онбординг сам і не питає замість нього.
**Якщо gate пройдено:** пайплайн продовжує зі Stage 1.
**Відмінність від Stage 6:** це перевірка структурної повноти профілю загалом, а не питання конкретної вакансії. Навіть після успішного Stage 0 окрема анкета все ще може містити щось не покрите — це вже Stage 6, не Stage 0.

### Stage 1 — Search
**Вхід:** `N`, `source`, `--method`, критерії/переваги користувача з `user_info.md`.
**Метод:** `auto` → спроба через API-шлях нижче; якщо вичерпані ретраї (Robustness) або розмітка стабільно не парситься → fallback на browser automation (як у job_search skill). `--method` форсує конкретний варіант.

**API-шлях.** За основу — https://github.com/MadsLorentzen/ai-job-search/tree/master/.agents/skills/linkedin-search/cli (регекс-парсинг, retry-логіка, query-параметри нижче звідти).

- **Endpoint:** `SEARCH_URL = https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search` — публічний «guest» endpoint LinkedIn, авторизація не потрібна.
- **Query params:**

  | param | значення | джерело |
  |---|---|---|
  | `keywords` | пошуковий запит (посада/скіл) | `Search criteria` (`user_info.md`) |
  | `location` | текстовий рядок локації (не geoId — endpoint приймає напряму) | `Search criteria` |
  | `f_TPR` | recency-фільтр, формат `r<seconds>` (напр. `r604800` = 7 днів) | опційно, з переваг користувача |
  | `f_WT` | work type: `1`=onsite, `2`=remote, `3`=hybrid | `Search criteria` (remote/hybrid/onsite) |
  | `start` | пагінація, 0-indexed offset, 10 результатів/сторінку: `start = (page-1) * 10` | лічильник пагінації цієї стадії |

- **Response:** сирий HTML зі списком `<li>` job cards — **не JSON**.
- **Parsing:** регекс, не повний DOM-парсер (markup неглибокий і стабільний; DOM-парсери мають відомі баги на вкладених `<div>` цих карток). Розбиття по маркеру `data-entity-urn="urn:li:jobPosting:` — кожен chunk парситься незалежно, одна побита картка не ламає решту (маркер тут потрібен лише для розбиття HTML на картки; значення з нього окремо як `id` пайплайну не зберігається — див. «Ідентифікація вакансії» нижче). З chunk: `title` (`h3.base-search-card__title`, fallback `span.sr-only`), `company`+`companyUrl` (`h4.base-search-card__subtitle`+вкладений `<a>`), `location` (`span.job-search-card__location`), `date` (`span.job-search-card__listdate[datetime]`), `url` (`a.base-card__full-link[href]`).
- **Robustness:** кастомні `User-Agent`/`Accept`/`X-Requested-With: XMLHttpRequest` заголовки; timeout 15s; exponential backoff з jitter на `429`/`5xx` (старт 500ms, ×2 до кепу 8s, максимум 6 ретраїв — лише після цього fallback на browser); `404` = порожній результат, не помилка.
- **ToS caveat.** Референс прямо попереджає: автоматизований доступ до цих ендпоінтів порушує ToS LinkedIn, призначено для персонального використання з низьким обсягом запитів, не для bulk-збору. Узгоджується з м'яким (не hard) лімітом часу з `brief.md` — обсяг/швидкість запитів свідомо не форсується вище розумного; точне число «скільки запитів/хв — це вже забагато» — TBD, див. Open questions.
- **Перевірено емпірично (2026-09-10, тестовий запит без параметрів автентифікації):** endpoint відповідає 200, ~10 карток/сторінку, усі поля (`title`/`company`/`location`/`date`/`url`) парсяться саме за наведеною вище regex-логікою без розбіжностей.
- **Знахідка — `location=Remote` як буквальний рядок НЕ фільтрує.** Запит з `location=Remote` повернув географічно мішані результати (Індія/UK/US впереміш) — LinkedIn не інтерпретує `"Remote"` як спеціальне значення цього параметра. Робочий варіант для remote-пошуку: реальна географічна `location` (напр. `"United Kingdom"`) + `f_WT=2` — це коректно звузило видачу саме до UK-локацій з remote-прапором. Таблицю вище виправлено відповідно.
**Ідентифікація вакансії: `url` — головне поле, `id` — лише унікальність запису.**
- `url` — повний, незмінений `href`: локаль-піддомен (`uk.linkedin.com`/`in.linkedin.com`/...), повний slug, усі query-параметри (`position`, `pageNum`, `refId`, `trackingId` тощо) — усе як є, без обрізання, без перебудови. Однаково для API-шляху (`a.base-card__full-link[href]`) і browser-fallback (той самий href з DOM). Приклад: `https://uk.linkedin.com/jobs/view/software-engineer-–-aws-at-localstack-4465695804?position=1&pageNum=0&refId=1W8DjAh0ajZL873zahN6Tw%3D%3D&trackingId=S1aWusZVzyJSCnNjJ9cnWQ%3D%3D`. В цьому полі відрізаємо всі queryParams, в наведеному URL це `?position=1&pageNum=0&refId=1W8DjAh0ajZL873zahN6Tw%3D%3D&trackingId=S1aWusZVzyJSCnNjJ9cnWQ%3D%3D` І далі оперуємо тільки з `https://uk.linkedin.com/jobs/view/software-engineer-–-aws-at-localstack-4465695804` Це головне поле — з ним пайплайн працює всюди: Stage 2 (detail-запит), Stage 5 (навігація), Stage 7 (tracker), дедуп.
- `id` — суто внутрішній лічильник унікальності запису в межах цього run (напр. послідовний `1..N`) — однаковий підхід для API-шляху і browser-fallback, без жодної залежності від LinkedIn-специфічних атрибутів на кшталт `data-entity-urn`. Має сенс лише всередині одного run: не зберігається і не звіряється між запусками.

**Дедуп тут же:** результати одразу звіряються з `application log / tracker` (Stage 7) за company+title, і за `url` (query-стрипнутий, стабільний між запусками — Stage 1 прибирає tracking-параметри одразу при захопленні) — дублікати відкидаються ще до глибокого парсингу (Stage 2), щоб не витрачати на них час.
**Пагінація до мети:** якщо після фільтра дублікатів і Stage 3 (fit-match) назбиралось менше за `N` придатних вакансій — пайплайн продовжує пошук (наступні сторінки видачі), а не зупиняється передчасно. Метрика з `brief.md` (soft target ≤1 година) — orientir, не hard stop.
**Вихід:** список кандидатів (`id` — run-local лічильник унікальності, `title`, `company`, `location`, `date`, повний `url` як є), з запасом понад `N` під подальший відсів.

**Example:**
```bash
node src/cli.js \
  --keywords "javascript engineer" \
  --location "United Kingdom" \
  --work-type hybrid \
  --recency 604800 \
  --count 5
[
  {
    "id": 1,
    "title": "Front-End JavaScript/TypeScript/React/AG Grid Software Engineer : Trading : £120-180k plus excellent bonus : London",
    "company": "Hunter Bond",
    "companyUrl": "https://uk.linkedin.com/company/hunter-bond?trk=public_jobs_jserp-result_job-search-card-subtitle",
    "location": "London Area, United Kingdom",
    "date": "2026-09-10",
    "url": "https://uk.linkedin.com/jobs/view/front-end-javascript-typescript-react-ag-grid-software-engineer-trading-%C2%A3120-180k-plus-excellent-bonus-london-at-hunter-bond-4463488300"
  },
  {
    "id": 2,
    "title": "Software Engineer (TypeScript, React/React Native, Node.js)",
    "company": "Oliver Bernard",
    "companyUrl": "https://uk.linkedin.com/company/oliverbernard?trk=public_jobs_jserp-result_job-search-card-subtitle",
    "location": "London Area, United Kingdom",
    "date": "2026-09-08",
    "url": "https://uk.linkedin.com/jobs/view/software-engineer-typescript-react-react-native-node-js-at-oliver-bernard-4462286425"
  },
  {
    "id": 3,
    "title": "Senior Frontend Engineer",
    "company": "Version 1",
    "companyUrl": "https://ie.linkedin.com/company/version-1?trk=public_jobs_jserp-result_job-search-card-subtitle",
    "location": "Belfast, Northern Ireland, United Kingdom",
    "date": "2026-09-06",
    "url": "https://uk.linkedin.com/jobs/view/senior-frontend-engineer-at-version-1-4230840352"
  },
  {
    "id": 4,
    "title": "Senior Front-End Developer (React, TypeScript) - VP, FX Options Pricing",
    "company": "Citi",
    "companyUrl": "https://www.linkedin.com/company/citi?trk=public_jobs_jserp-result_job-search-card-subtitle",
    "location": "London, England, United Kingdom",
    "date": "2026-09-08",
    "url": "https://uk.linkedin.com/jobs/view/senior-front-end-developer-react-typescript-vp-fx-options-pricing-at-citi-4463556597"
  },
  {
    "id": 5,
    "title": "Senior Frontend Engineer (React/React Native)",
    "company": "Emma - we are hiring!",
    "companyUrl": "https://uk.linkedin.com/company/emma-technologies-ltd?trk=public_jobs_jserp-result_job-search-card-subtitle",
    "location": "Islington, England, United Kingdom",
    "date": "2026-09-04",
    "url": "https://uk.linkedin.com/jobs/view/senior-frontend-engineer-react-react-native-at-emma-we-are-hiring%21-4461181287"
  }
]
```

### Stage 2 — Extract vacancy data
**Вхід:** список кандидатів зі Stage 1 — `id` (run-local лічильник унікальності) і `url` (query-стрипнутий, з Stage 1).

**Дія.** Жодного окремого API-ендпоінта не потрібно — пайплайн просто відкриває `url` кожного кандидата напряму: це той самий публічний `/jobs/view/<slug>-<id>`, вже без query-параметрів (Stage 1). Ті самі Robustness-правила, що й у Stage 1 (custom headers, timeout, retry/backoff на 429/5xx).

**Перевірено емпірично (2026-09-10):** неавторизований запит саме на цю публічну сторінку (не на окремий guest API) повертає 200, без authwall, ~330KB HTML — більше за раніше розглянутий guest API endpoint (~28KB, бо там була лише AJAX-партиція без чрому сайту), але з усіма тими самими маркерами: `show-more-less-html__markup`/`description__text` (опис), `topcard__title`/`top-card-layout__title` (заголовок), `topcard__org-name-link` (компанія), `description__job-criteria-*` (seniority/employment type/job function/industries). Той самий regex-парсинг працює без змін, просто на іншому джерелі HTML.

**Parsing:** `title`, `company`+`companyUrl`, `location`, повний `description` (нормалізація `<br>`/блокових тегів у переноси рядків — тег-структура важлива тут, бо опис — джерело вимог для Stage 3), `seniority`/`employmentType`/`jobFunction`/`industries` (job-criteria пари), і `isActive` — **best-effort** ознака (детектиться банер «no longer accepting applications»; відсутність банера — не доказ, що вакансія відкрита, лише відсутність доказу протилежного, розмітка могла й просто змінитись).

**Apply-channel сигнал: onsite/offsite — реальний і надійний, підтверджено на новій вибірці.** Попередній висновок («маркер константний, це просто анонімний-перегляд артефакт») був хибний — базувався на 3 вакансіях, які випадково виявились однотипними. Перевірено заново на 10 свіжих вакансіях (2026-09-10): маркер **варіюється** — 3 з 10 показали `apply-button__offsite-apply-icon-svg`, 7 — ні. Точний і надійний сигнал — атрибут `data-tracking-control-name` на кнопці `id="topbar-apply"`:
- `public_jobs_apply-link-onsite` або `public_jobs_apply-link-simple_onsite` → **onsite** (подача лишається на LinkedIn — rating 0 або 1 у таблиці Stage 3).
- `public_jobs_apply-link-offsite_...` (супроводжується `apply-button__offsite-apply-icon-svg` і обгорткою `contextual-sign-in-modal`) → **offsite** (External Apply — rating 2 або 3).

**Уточнення (2026-09-10, під час імплементації Stage 2 скрипта).** Для onsite сигнал справді сидить прямо в `data-tracking-control-name` кнопки `id="topbar-apply"`, як і описано вище. Але для offsite розмітка виявилась іншою: сама кнопка тепер має generic `data-tracking-control-name="public_jobs_contextual-sign-in-modal_ssr-ui-lib-outlet-button"` (тригер модалки, не apply-link), а реальний `public_jobs_apply-link-offsite_contextual-sign-in-modal` сидить в атрибуті `data-impression-id` сусіднього `<div class="contextual-sign-in-modal">`, що йде одразу за кнопкою. Перевірено на 15 вакансіях (11 offsite за цим сигналом, 4 onsite — прямий `data-tracking-control-name` спрацював для всіх 4). Парсер має перевіряти обидва місця: спершу `data-tracking-control-name` кнопки, і якщо там generic-значення — `data-impression-id` найближчого наступного елемента.

Це дає Stage 2 (навіть на API-шляху, без browser) грубий, але реальний поділ apply-channel навпіл. Що він **не** дає (поки): розрізнення 0 від 1 всередині onsite, і 2 від 3 всередині offsite.

**Rating 4 (Meet the hiring team) — теж є реальний сигнал, знайдено на прикладі** (`https://www.linkedin.com/jobs/view/4458957079/`, Digital Waffle). Коли у вакансії показаний рекрутер, сторінка містить окремий блок:

```html
<div class="message-the-recruiter">
  <p>Direct message the job poster from Digital Waffle</p>
  ...
  <a class="base-card__full-link" href="https://uk.linkedin.com/in/stuart-manser-49a38b130" ...>
  <h3 class="base-main-card__title">Stuart Manser</h3>
  <h4 class="base-main-card__subtitle">Software Development Recruitment Manager at Digital Waffle ...</h4>
  <a class="message-the-recruiter__cta" href="https://www.linkedin.com/login?...&session_redirect=...">
</div>
```

Присутність `class="message-the-recruiter"` — надійний, перевірений сигнал rating 4: із цього ж блоку дістаються ім'я рекрутера, посада і його LinkedIn-профіль (`base-card__full-link` усередині) — тобто це водночас і детекція rating 4, і джерело поля **recruiter contact**, яке Stage 2 вже мав визначати окремо (Дія нижче). Сама кнопка `message-the-recruiter__cta` веде на `/login?...` (реально написати рекрутеру можна лише авторизованим), але для нашої мети досить самого факту присутності блоку на сторінці — вакансію не потрібно логінитись, щоб побачити, що ця опція існує.

Ця вакансія (4458957079) — до речі onsite (без `apply-button__offsite-apply-icon-svg`), що ставить питання: чи "Meet the hiring team" — це справді 5-та точка на тій самій шкалі 0-4, чи окрема незалежна ознака («є контакт рекрутера: так/ні»), яка теоретично могла б співіснувати і з offsite-вакансією теж. Наразі перевірено тільки на одному (onsite) прикладі — див. Open questions.

Що досі не має сигналу з неавторизованого fetch: розрізнення Easy Apply (0) від звичайного LinkedIn apply (1), і External ATS (2) від сайту компанії (3). Це лишається кандидатом на browser-крок.

**Нова знахідка — soft rate-limit, не 429.** Під час того самого тесту (10 послідовних запитів без затримки) останні 3 з 10 повернули **HTTP 200**, але тілом був не job-контент, а крихітна (792 байти) JS-редирект сторінка на `linkedin.com/authwall` (`window.location.href = "https://www.linkedin.com/authwall?..."`). Наявний Robustness-механізм (retry/backoff) у Stage 1/2 реагує на статус-коди `429`/`5xx` — цей кейс їх не зачіпає, бо статус — **200**. Перетестував один із цих трьох через ~3с затримки — повернувся повний контент (200, 288KB, `apply-link-onsite`) без жодних змін в URL/заголовках. Тобто це **тимчасовий**, не по-вакансійний soft-block: спрацьовує після кількох швидких запитів поспіль, минає сам. **Наслідок:** Stage 2 (і Stage 1) мають детектувати цей кейс за вмістом відповіді (малий розмір тіла + присутність `authwall` у ньому), не лише за статус-кодом, і застосовувати той самий backoff, що й на 429 — інакше такий "порожній" fetch буде хибно розпізнано як реальні (порожні/некоректні) дані вакансії.

**ToS caveat.** Той самий caveat, що й у Stage 1 (справжня персональна сторінка, не «guest» endpoint — якщо щось, тут обережність доречна ще більше): низький обсяг запитів, не для bulk-збору. Знахідка вище — це якраз конкретний, вимірюваний прояв того, що відбувається, коли обсяг/швидкість перевищені.

**Дія:** для кожної вакансії також довизначається recruiter contact (з блоку `message-the-recruiter`, якщо показаний — див. вище: ім'я, посада, LinkedIn-профіль), ATS-система (якщо External Apply веде на сторонній ATS — фіксується як потенційне джерело для прямого пошуку в майбутньому, див. glossary), і apply-channel (Stage 3 таблиця: onsite/offsite і rating 4 — за сигналами вище; 0 vs 1 і 2 vs 3 все ще доуточнюються, де потрібно, окремим browser-кроком).
**Вихід:** vacancy input (структура) на кожну вакансію, з полем `apply_channel`.

**Example:**
```bash
node src/cli.js --keywords "backend engineer" --location "United Kingdom" --count 5 | node src/stage2-cli.js
[
  {
    "id": 1,
    "url": "https://uk.linkedin.com/jobs/view/senior-backend-engineer-php-at-arrive-4455257010",
    "date": "2026-09-10",
    "title": "Senior Backend Engineer - PHP",
    "company": "Arrive",
    "companyUrl": "https://se.linkedin.com/company/arrive?trk=public_jobs_topcard-org-name",
    "location": "London, England, United Kingdom",
    "description": "We’ve signed up to an ambitious journey. Join us!\n\nAs Arrive, we guide customers and communities towards brighter futures and more livable cities, it isn’t a challenge just anyone could take on. Luckily, we have something to help us make it happen. Our people and our values. We Arrive Curious, Focused and Together. Just as our entire brand is inspired by the North Star, the shining light leading travelers to their destinations since time began, our values guide us. They help us be at our best. For our customers. For the cities and communities we serve. For ourselves. As a global team, we are transforming urban mobility. Let’s grow better, together.\n\nRole Overview\n\nWe are seeking a Senior Backend Engineer with deep expertise in PHP 8+ and Laravel. You will be a key architect in our shift toward a robust microservices and event-driven architecture. This isn’t just a \"coding\" role; we expect our seniors to be platform-aware, helping us move away from a \"throw it over the wall\" culture to one of true engineering ownership.\n\nKey Responsibilities\n\n- Architecture & Development: Design and implement scalable microservices using PHP 8.4 and Laravel.\n\n- Infrastructure Ownership: Leverage AWS and Docker to deploy and manage services. We value engineers who can navigate container orchestration independently.\n\n- Data Integrity: Optimize MySQL for transactional reliability and utilize MongoDB or Redis for high-performance data needs.\n\n- Event-Driven Design: Build decoupled systems using asynchronous patterns (SQS/Event systems) to ensure marketplace resilience.\n\n- Testing & Quality: Implement TDD (Unit and Integration) to protect our core revenue Streams\n\nRequired Skills\n\n- 5-8 years of Development experience\n\n- Essential: Strong proficiency in PHP 8+ / Laravel, MySQL, and Docker.\n\n- Experience: Proven track record in Microservices and Event-Driven Design.\n\n- Cloud: Solid understanding of AWS core services.\n\nDesired Skills\n\n- (The \"Platform-Aware\" edge): Infrastructure-as-Code experience (Terraform).\n\n- Knowledge of GoLang for high-performance services or Lambdas.\n\n- Experience with OpenSearch and Redis.\n\n- Familiarity with VueJS to assist in full-stack collaboration.\n\n- Knowledge of Kubernetes.\n\nAbout Arrive\n\nArrive, including brands like EasyPark, Flowbird, RingGo, ParkMobile and Parkopedia, is a leading global mobility platform. Present in over 90 countries and 20,000 cities, the company helps people and decision-makers make smarter decisions about urban mobility and ease the experience of travel worldwide. Arrive delivers a unique combination of the core ingredients to make cities more livable: from smart payments and optimized car parks to data-driven traffic reduction and support for reinvestment in public transport and green space. It’s about more than function, it’s about saving time and simplifying the experience of travel for everyone. Travel is more than a journey, it’s how you Arrive.",
    "seniority": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Engineering and Information Technology",
    "industries": "IT Services and IT Consulting",
    "isActive": true,
    "applyChannel": "offsite",
    "applyTrackingControlName": "public_jobs_contextual-sign-in-modal_ssr-ui-lib-outlet-button",
    "hasOffsiteIcon": true,
    "isMeetTheHiringTeam": false,
    "fetchStatus": "ok"
  },
  {
    "id": 2,
    "url": "https://uk.linkedin.com/jobs/view/senior-software-engineer-at-weekday-ai-yc-w21-4455769640",
    "date": "2026-07-24",
    "title": "Senior Software Engineer",
    "company": "Weekday AI (YC W21)",
    "companyUrl": "https://www.linkedin.com/company/weekdayjobs?trk=public_jobs_topcard-org-name",
    "location": "London, England, United Kingdom",
    "description": "This role is for one of the Weekday's clients\n\nMin Experience: 6 years\n\nLocation: London\n\nJobType: full-time\n\nWe are seeking a highly skilled and experienced Senior Software Engineer with deep expertise in Python to join our growing engineering team. In this role, you will be responsible for designing, developing, and maintaining scalable, high-performance applications while playing a key role in shaping technical architecture and mentoring junior engineers.\n\nRequirements\n\nKey Responsibilities\n\n-  Design, develop, and maintain robust, scalable backend systems and APIs using Python.\n\n-  Lead end-to-end development of complex software solutions, from concept to deployment.\n\n-  Write clean, efficient, and reusable code following best practices and coding standards.\n\n-  Collaborate with cross-functional teams including product managers, designers, and DevOps to deliver high-quality features.\n\n-  Optimize application performance, reliability, and scalability.\n\n-  Participate in architectural discussions and contribute to technical decision-making.\n\n-  Conduct code reviews and ensure adherence to quality standards.\n\n-  Troubleshoot, debug, and resolve production issues in a timely manner.\n\n-  Mentor junior developers and contribute to building a strong engineering culture.\n\nRequired Skills & Qualifications\n\n-  6-11 years of professional software development experience with strong expertise in Python.\n\n-  Solid understanding of Python frameworks such as Django, Flask, or FastAPI.\n\n-  Experience in building RESTful APIs and microservices architecture.\n\n-  Strong knowledge of data structures, algorithms, and object-oriented programming.\n\n-  Hands-on experience with databases such as PostgreSQL, MySQL, or MongoDB.\n\n-  Familiarity with asynchronous programming and performance optimization techniques.\n\n-  Experience with cloud platforms (AWS, GCP, or Azure) and containerization tools like Docker.\n\n-  Knowledge of CI/CD pipelines and version control systems such as Git.\n\n-  Strong problem-solving skills and the ability to work in a fast-paced environment.\n\nPreferred Qualifications\n\n-  Experience working with distributed systems and event-driven architectures.\n\n-  Exposure to data processing frameworks or background job systems (Celery, Kafka, etc.).\n\n-  Familiarity with testing frameworks and test-driven development (TDD).\n\n-  Understanding of security best practices in application development.\n\n-  Prior experience in leading small teams or projects is a plus.\n\nSoft Skills\n\n-  Excellent communication and collaboration skills.\n\n-  Strong ownership mindset with attention to detail.\n\n-  Ability to work independently and manage multiple priorities.\n\n-  Passion for learning new technologies and continuous improvement",
    "seniority": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Other",
    "industries": "IT Services and IT Consulting",
    "isActive": true,
    "applyChannel": "onsite",
    "applyTrackingControlName": "public_jobs_apply-link-onsite",
    "hasOffsiteIcon": false,
    "isMeetTheHiringTeam": false,
    "fetchStatus": "ok"
  },
  {
    "id": 3,
    "url": "https://uk.linkedin.com/jobs/view/senior-backend-developer-node-js-typescript-at-client-server-4455588772",
    "date": "2026-08-18",
    "title": "Senior Backend Developer Node.js TypeScript",
    "company": "Client Server",
    "companyUrl": "https://uk.linkedin.com/company/client-server?trk=public_jobs_topcard-org-name",
    "location": "West Midlands, England, United Kingdom",
    "description": "Senior Backend Developer / Developer (Node.js TypeScript Kafka) Remote UK to £80k\n\nAre you a backend focussed Software Developer / Engineer looking for an opportunity to take ownership and progress your career at a scaling tech company?\n\nYou could be joining a growing games company that combines state of the art technology, gaming and luxury fashion.\n\nWhat's in it for you:\n\n- Salary to £80k\n\n- Remote working\n\n- Private medical care\n\n- Life Assurance\n\n- 25 days holiday plus your birthday off\n\n- Impactful role with excellent career progression as the company scales\n\nYour role:\nAs a Senior Backend Developer you'll join the team as they scale the product to support millions of users. You'll design and deliver high-quality, maintainable backend code and features using TypeScript and Node.js that is aligned with established codebase architectural standards and covered by tests as well as supporting backend system performance and reliability, helping to maintain 99% uptime SLA.\n\nYou'll design, implement and extend robust APIs and microservices supporting gameplay, user management, platform and content management systems, collaborating with product and game teams to ensure alignment of features with backend architecture and with DevOps to ensure uptime, observability and deployment reliability.\n\nThis is a Senior Backend Developer role where you'll take ownership of complex systems and proactively address potential performance and scalability bottlenecks.\n\nLocation / WFH:\nYou can work from home from anywhere in the UK. Please note: you must be a UK citizen or hold the right to work without visa restrictions.\n\nAbout you:\n\n- You have strong backend software engineering experience with Node.js and TypeScript\n\n- You have experience with Kafka and Event Driven Architectures\n\n- You have a good knowledge of microservices, RESTful APIs and scalable system architecture\n\n- You have experience of working with relational and NoSQL databases (PostgreSQL, MySQL, MongoDB, DynamoDB)\n\n- You have a strong appreciation of DevOps, CI/CD, GitHub Actions, Jenkins\n\n- You're familiar with containerisation (Docker), cloud services (AWS), and Infrastructure-as-Code (Terraform)\n\n- You're comfortable taking ownership of projects, working with the Lead Engineer and mentoring more junior team members\n\n- You're collaborative and pragmatic with great communication skills\n\nApply now to find out more about this Senior Backend Developer / Engineer (Node.js TypeScript) opportunity.",
    "seniority": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Engineering, Information Technology, and Consulting",
    "industries": "Software Development, Technology, Information and Media, and Computer Games",
    "isActive": true,
    "applyChannel": "onsite",
    "applyTrackingControlName": "public_jobs_apply-link-onsite",
    "hasOffsiteIcon": false,
    "recruiterContact": {
      "name": "Thomas Hayward",
      "profileUrl": "https://uk.linkedin.com/in/thomas-hayward-064a67335"
    },
    "isMeetTheHiringTeam": true,
    "fetchStatus": "ok"
  },
  {
    "id": 4,
    "url": "https://uk.linkedin.com/jobs/view/senior-backend-engineer-revenue-at-arrive-4455237926",
    "date": "2026-09-07",
    "title": "Senior Backend Engineer - Revenue",
    "company": "Arrive",
    "companyUrl": "https://se.linkedin.com/company/arrive?trk=public_jobs_topcard-org-name",
    "location": "London, England, United Kingdom",
    "description": "We’ve signed up to an ambitious journey. Join us!\n\nAs Arrive, we guide customers and communities towards brighter futures and more livable cities, it isn’t a challenge just anyone could take on. Luckily, we have something to help us make it happen. Our people and our values. We Arrive Curious, Focused and Together. Just as our entire brand is inspired by the North Star, the shining light leading travelers to their destinations since time began, our values guide us. They help us be at our best. For our customers. For the cities and communities we serve. For ourselves. As a global team, we are transforming urban mobility. Let’s grow better, together.\n\nThe Role\n\nAs a Senior Backend Engineer, you'll design and build scalable backend services, APIs and infrastructure that enable pricing capabilities and revenue growth. Working closely with Product, Pricing, Data and Engineering teams, you'll translate commercial ideas into robust technical solutions while helping shape the future architecture of our revenue platform. This is a hands-on engineering role where you'll take ownership of solutions from design through to delivery, working on systems that directly impact business performance.\n\nWhat You'll Be Doing\n\n- Design, develop and maintain scalable backend services using PHP and Laravel.\n\n- Build APIs and backend infrastructure that support pricing, revenue and marketplace functionality.\n\n- Develop and maintain operational data models and data pipelines.\n\n- Work closely with the Head of Pricing to implement commercial initiatives and new pricing capabilities.\n\n- Build reliable, scalable and observable systems using modern engineering practices, including CI/CD, automated testing and monitoring.\n\n- Contribute to technical design, architecture discussions and peer reviews.\n\n- Continuously improve the performance, scalability and resilience of revenue-critical systems.\n\nAbout You\n\nYou'll be an experienced backend engineer who enjoys solving complex technical problems and working collaboratively across teams.\n\nYou'll Ideally Have\n\n-  5+ years' experience building production backend systems\n\n-  Strong commercial experience with PHP and Laravel\n\n-  Experience building scalable backend services and REST APIs\n\n-  Strong SQL skills and experience working with relational databases\n\n-  Familiarity with AWS or similar cloud environments\n\n-  Experience with CI/CD pipelines and automated testing\n\n-  Strong understanding of software architecture, scalability and system design\n\n-  Excellent communication skills and the ability to explain technical concepts to non-technical stakeholders\n\n-  A proactive mindset with the ability to work independently and take ownership..\n\nNice to Have\n\nExperience with any of the following would be beneficial, but isn't essential:\n\n-  Pricing or revenue optimisation platforms\n\n-  Marketplace or e-commerce environments\n\n-  Data pipelines or operational data models\n\n-  Modern data tooling or orchestration platforms\n\n-  Experimentation or A/B testing platforms\n\n-  Exposure to machine learning workflows or analytics platforms\n\nAbout Arrive\n\nArrive, including brands like EasyPark, Flowbird, RingGo, ParkMobile and Parkopedia, is a leading global mobility platform. Present in over 90 countries and 20,000 cities, the company helps people and decision-makers make smarter decisions about urban mobility and ease the experience of travel worldwide. Arrive delivers a unique combination of the core ingredients to make cities more livable: from smart payments and optimized car parks to data-driven traffic reduction and support for reinvestment in public transport and green space. It’s about more than function, it’s about saving time and simplifying the experience of travel for everyone. Travel is more than a journey, it’s how you Arrive.",
    "seniority": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Engineering and Information Technology",
    "industries": "IT Services and IT Consulting",
    "isActive": true,
    "applyChannel": "offsite",
    "applyTrackingControlName": "public_jobs_contextual-sign-in-modal_ssr-ui-lib-outlet-button",
    "hasOffsiteIcon": true,
    "isMeetTheHiringTeam": false,
    "fetchStatus": "ok"
  },
  {
    "id": 5,
    "url": "https://uk.linkedin.com/jobs/view/senior-software-engineer-backend-at-apron-4453414683",
    "date": "2026-08-19",
    "title": "Senior Software Engineer | Backend",
    "company": "Apron",
    "companyUrl": "https://uk.linkedin.com/company/getapron?trk=public_jobs_topcard-org-name",
    "location": "London, England, United Kingdom",
    "description": "About Apron\n\nSmall businesses are the backbone of the economy, but the systems they rely on for payments are slow, manual and were never built for them. Apron is fixing that. We digitise and simplify how SMBs manage cash flow: capturing invoices, issuing expense cards, and moving money in one place.\n\nFounded in 2021, we've grown to ~100 people across the UK, Germany, Spain and raised $50M, backed by Index Ventures, Bessemer Venture Partners, Zinal Grow and Tony Fadell.\n\nOur next phase of growth isn’t incremental. We’re building a category-defining, global fintech business with a clear path to significant revenue scale and international expansion. This phase requires not just a great product but a world-class engineering team.\n\nOur engineering culture\n\n- We build with the customer in mind. Top-tier technology, in service of making their lives genuinely easier.\n\n- We own our work. We plan, break it down, and ship it end to end.\n\n- We embrace the complexity of finance. Money means intricate business logic and real edge cases. Precision matters here.\n\n- We write code we're proud of. Fast doesn't mean sloppy, we build for the long term.\n\n- We use AI where it helps. The best tools available, used to build better products faster.\n\nWhat You’ll Own\n\nWe're hiring more than one engineer for different teams, this means:\n\n- You’ll build and scale the backend powering our core product lines like Bill Pay or Apron Card and the systems our business depends on like fraud detection.\n\n- You'll work cross-functionally with Frontend Engineers, Product Managers and Product Designers to ship new features from discovery through to production.\n\n- You’ll design financial integrations where security and speed both matter.\n\n- You’ll share your experience with others, driving innovation, proactively suggesting improvements and raising the bar for the team.\n\nWhat You’ll Need\n\n- 8+ years of continuous experience as a backend engineer.\n\n- Previous in-house experience working in a product-led + fast-paced environment (startup or Tech company).\n\n- Proficient in JVM-based languages, ideally Kotlin, for server-side development.\n\n- Comfort with relational databases and the trade-offs that come with them at scale.\n\n- Keen attention to code quality, passion for efficient architecture, and commitment to optimising performance.\n\n- Would be a plus if you have:\n\n- Hands-on Kotlin experience.\n\n- Kubernetes and Terraform experience.\n\n- Deep Postgres experience: GIST indexes, partitioning, replication.\n\nWhat We Offer\n\n- Highly competitive salary + meaningful stock options\n\n- Pension plan with Nest\n\n- Health insurance (including Optical and Dental cover), Life Assurance\n\n- Enhanced parental leave\n\n- Weekly Deliveroo allowance\n\n- 29 days of holidays (on top of Bank holidays)\n\n- Flexible working hours\n\n- Hybrid work 3 days a week in our London (Liverpool Street) offices.\n\n- Cycle to Work scheme, Electric vehicle scheme\n\n- Visa sponsorship (when applicable)\n\nOur hiring process\n\nOur process is straightforward and runs at your pace. We aim to provide feedback in 24hrs.\n\n- Interview with our Recruiting team\n\n- 2 Technical Interviews\n\n- 2 Final Interviews with our Leadership team\n\n- Offer in 24hrs",
    "seniority": "Mid-Senior level",
    "employmentType": "Full-time",
    "jobFunction": "Engineering and Information Technology",
    "industries": "Financial Services",
    "isActive": true,
    "applyChannel": "offsite",
    "applyTrackingControlName": "public_jobs_contextual-sign-in-modal_ssr-ui-lib-outlet-button",
    "hasOffsiteIcon": true,
    "isMeetTheHiringTeam": false,
    "fetchStatus": "ok"
  }
]
```

### Stage 3 — Match / fit
**Вхід:** vacancy input (Stage 2) + `base_cv.md` + `user_info.md`.
**Дія:** матчинг вимог вакансії проти профілю — що важливе (веде CV), що допоміжне, що можна відкинути. Якщо вакансія не проходить обмеження з `user_info.md` (стек/рівень/локація/зарплата тощо) — вакансія пропускається (flag «skipped — fit»), у Stage 1 запускається пошук наступного кандидата на її місце.

**Apply-channel rating.** Кожній вакансії присвоюється рейтинг 0–4 за способом подачі — від найпасивнішого до найбільш «робочого» (найвищий шанс реального контакту з людиною):

| rating | channel | опис |
|---|---|---|
| 0 | Easy Apply | one-click подача всередині LinkedIn, без прямого контакту з людиною |
| 1 | LinkedIn apply (не Easy Apply) | подача лишається на LinkedIn, але не через спрощений Easy Apply флоу |
| 2 | External ATS | External Apply, що веде на сторонній ATS (Greenhouse, Lever, Workday тощо) |
| 3 | Сайт компанії | подача напряму на кар'єрній сторінці компанії, поза LinkedIn і поза відомим ATS |
| 4 | Meet the hiring team | подача + пряме звернення до HR/рекрутера, показаного у вакансії — найвищий рейтинг, бо додає особистий контакт до самої подачі |

**Що вже відомо зі Stage 2, що ні.** Надійні сигнали з неавторизованого fetch, вже на Stage 2: грубий поділ {0,1} vs {2,3} (onsite vs offsite, `data-tracking-control-name`, підтверджено на 10 вакансіях) і rating 4 (блок `message-the-recruiter`, підтверджено на 1 прикладі). Точне число всередині {0,1} і {2,3} — сигналу поки нема, лишається за browser-кроком.

**Вплив на відбір:**
- якщо `--channel` заданий (явно або розпізнаний з природної мови запиту, див. «Команда запуску») — це **фільтр**: у квоту `N` йдуть лише вакансії з rating ≥ вказаного значення. Якщо таких не вистачає до `N` навіть після вичерпного пошуку (Stage 1) — пайплайн не знижує планку, а репортує нестачу в Stage 8 summary (той самий принцип «не знижувати бар для досягнення числа», що й при fit-skip).
- якщо `--channel` не заданий — рейтинг використовується лише як **tie-breaker**: коли кандидатів, що пройшли fit, більше за `N`, у пріоритеті — вакансії з вищим rating.

**Вихід:** content selection на CV-генерацію (Stage 4) для вакансій, що пройшли fit (і, за наявності, channel-фільтр).

### Stage 4 — Generate CV
**Вхід:** content selection (Stage 3) + `base_cv.md` + `user_info.md`.

**Чому це не "просто згенеруй CV".** «Добери найкращі bullets під вакансію» — це судження, не детермінований алгоритм. У job_search skill (`tailor`) це судження робив сам Олег — перегляд і затвердження перед кожним використанням. У job_pipeline це судження приймає **той самий LLM-агент, що виконує `apply`** — Stage 4 не описує формулу підрахунку релевантності, а дає йому rubric, за яким приймати рішення:

1. **Match до вимог вакансії.** Зі structured даних Stage 2 (seniority/employment type/опис) і `Search criteria` — які bullets/навички демонструють саме той рівень і стек, що просить вакансія.
2. **Дзеркалення термінології вакансії.** Пріоритет bullets/skills, що використовують ті самі терміни/формулювання, що й опис вакансії (Stage 2) — підвищує pattern-match і для ATS, і для людини, яка читає по діагоналі.
3. **Canonical vs extended pool** (`base_cv.md`, див. `user_data.md`): чи є в extended pool bullet, що пасує цій вакансії краще за той, що зараз у canonical наборі — підміняється, якщо так.
4. **CV як реклама** (той самий принцип, що й у job_search `tailor`): увага читача падає з кожним рядком — найпереконливіший, найбільш релевантний матеріал має вести, не просто десь бути присутнім. Summary/opening line теж кандидат на переформулювання під конкретну вакансію, не завжди канонічний варіант.
5. **Contact — лише з `user_info.md`** (не з `base_cv.md` — там його взагалі нема, див. `user_data.md`), береться в момент рендеру, без окремої копії.

**Enforcement «одна сторінка A4» — конкретний цикл, не побажання.** Рендер → перевірка обсягу (кількість сторінок/переповнення) → якщо більше однієї сторінки: прибрати найменш релевантний bullet (спершу підміни з extended pool, потім canonical — за пріоритетом з rubric вище) → рендер знову → повторювати, доки не влізе в одну сторінку.

**Дія:** генерується tailored CV під конкретну вакансію за rubric вище, з enforcement-циклом на розмір.

**Опційна автоматична QA-перевірка (флаг, off за замовчуванням).** Якщо ввімкнено — одразу після генерації запускається окремий (незалежний від того, що генерував CV) агент: отримує вакансію (Stage 2), згенерований CV, і `base_cv.md`+`user_info.md`, перевіряє відповідність/якість підбору. Це друга думка від агента, а не людини — самостійна опція, не заміна людському рев'ю нижче.

**Опційний per-CV людський рев'ю (число, off за замовчуванням).** Параметр задає частоту показу згенерованого CV користувачу для ручного підтвердження перед Stage 5: `0` — показувати кожен; `N` — показувати кожен (N+1)-й (тобто `1` = через один); без значення/дефолт — жодного per-CV показу (узгоджується з ціллю `brief.md` «без ручного втручання, де можливо»). Не заміняє Stage 6 (там — анкетні питання конкретної подачі; тут — власне контент CV).

**Зберігання:** тимчасово, у temp-директорії пайплайну (шлях — TBD) до успішної подачі.
**Вихід:** готовий CV файл на вакансію.

### Stage 5 — Apply / form-fill
**Вхід:** tailored CV (Stage 4), vacancy input (Stage 2), `user_info.md`.
**Дія:** подача через Easy Apply (LinkedIn) або перехід і подача через External Apply/ATS. Прикріплюється CV з Stage 4, cover letter за потреби, стандартні анкетні поля заповнюються з `user_info.md`.
**Розгалуження на Stage 6:** якщо анкета містить питання, якого нема в `base_cv.md`/`user_info.md`, або відповідь неоднозначна — pipeline зупиняється на цьому пункті й іде в Stage 6.

**Technical handoff (окремо від Stage 6).** Якщо пайплайн технічно не може виконати конкретну дію — кнопка/file input недоступні для автоматизації, елемент не має `ref`, модалка ізольована тощо (обмеження інструменту, а не питання контенту) — пайплайн не провалює подачу і не йде в Stage 6. Замість цього:
1. Зупиняється саме на цьому мікро-кроці, просить користувача виконати тільки його (напр. «натисни Upload і обери `cv/tmp/<company_slug>/...`»).
2. Після підтвердження від користувача — керування повертається пайплайну, і він продовжує сам з наступного кроку (заповнення решти форми, review, submit) без повторного проходження вже зроблених кроків.
3. Такий випадок — не «failed»: подача успішна, просто з одним ручним кроком всередині.

**Known issues log (перевикористання між запусками).** Коли технічний блокер виявлено вперше — пайплайн одразу фіксує його в known-issues документі (шлях — TBD, напр. `docs/known_issues.md`): джерело/ATS, який саме крок недоступний і чому, яким ручним кроком він вирішується. У наступних запусках на тому самому джерелі/кроці пайплайн одразу йде в handoff, не витрачаючи спроб на автоматизацію, що вже відома як непрацездатна (аналогічно «Known limitation» в job_search skill — resume-upload крок Easy Apply).

**Вихід:** успішна подача (сама або через handoff) → Stage 7. Справжній «failed» — коли технічний блокер не вдалось обійти навіть handoff'ом (напр. користувач не зміг/відмовився виконати ручний крок, або ресурс став недоступний) — фіксується як «failed» у summary (Stage 8), quota-слот не витрачається намарно (пайплайн намагається компенсувати наступним кандидатом, як і при fit-skip).

### Stage 6 — Clarification loop
**Тригер:** Stage 5 знайшла питання поза документами користувача, або суперечність.
**Дія:** пайплайн питає користувача напряму, чекає відповідь.
**Запис:** відповідь одразу дописується/оновлюється в `user_info.md` (без додаткового підтвердження — сама відповідь є підтвердженням), пайплайн продовжує з того ж місця.
**Slдід у summary:** усі записи, додані/оновлені в `user_info.md` під час цього запуску, підсвічуються окремим блоком у Stage 8 summary — користувач бачить, що саме змінилось у профілі за один погляд.

### Stage 7 — Track & archive
**Тригер:** успішна подача (після Stage 5).
**Tracker:** додається рядок у загальний `applications.csv` (application log/tracker) — компанія, посада, джерело, **лінк = `url` (query-стрипнутий, Stage 1)**, дата, статус=Applied, CV used, **apply-channel rating** (Stage 3), і т.д. (точна схема колонок — TBD).
**CV archive:** CV переноситься з temp (Stage 4) у постійну директорію на вакансію, іменовану по компанії (`cv/applied/<company_slug>/...` — точна конвенція неймінгу при колізіях імен компаній — TBD).

### Stage 8 — Summary
Наприкінці запуску (quota `N` досягнута, або кандидати на LinkedIn вичерпані) — підсумок у вигляді таблиці/списку:
- скільки подано з `N` запитаних;
- скільки пропущено як дублікат (dedup, Stage 1);
- скільки пропущено як не fit (Stage 3);
- скільки провалилось технічно (Stage 5, «failed»);
- скільки пройшло через technical handoff (Stage 5) — успішні, але з ручним кроком, і які саме кроки/джерела;
- розбивка поданих за apply-channel rating (Stage 3) — скільки на кожному рівні 0–4, і чи вистачило до `N` за заданим `--channel` фільтром, якщо він був;
- який метод пошуку використовувався (api / browser / auto-fallback спрацював чи ні);
- окремий блок: які записи `user_info.md` додані/оновлені за цей запуск (Stage 6).

## Open questions / TBD
- Точна схема колонок `applications.csv`.
- Шлях temp-директорії для CV на етапі Stage 4 (до підтвердженої подачі).
- Точний формат/toolchain рендеру CV (Stage 4) — переносити job_search-подібний content.js+generate.js+LibreOffice конвеєр, чи простіший прямий шлях (напр. Markdown/HTML → PDF) — не вирішено, `job_pipeline` навмисно незалежний від job_search-івської інфраструктури.
- Точний спосіб програмно виміряти «чи влазить в одну сторінку A4» (Stage 4 enforcement-цикл) — page-count з рендер-інструменту, чи проксі на кшталт підрахунку рядків/символів перед рендером.
- Точна назва/синтаксис флагів для опційної QA-перевірки і для числа `--review-every`-подібного параметра (Stage 4) — узгодити зі стилем `--method`/`--channel` з «Команда запуску».
- Конвенція неймінгу `cv/applied/<company_slug>/` при колізії назв компаній.
- Точний шлях і структура known-issues документа Stage 5 (напр. `docs/known_issues.md`) — один спільний файл чи розбивка по джерелу/ATS; формат запису (джерело, крок, причина, ручне рішення).
- Скільки разів пайплайн пробує технічну дію сама, перш ніж визнати її handoff-кейсом (одразу за відомим known-issues записом, чи спершу одна спроба навіть для нового блокера).
- Назва й точний інтерфейс скіла/команди `apply`.
- Apply-channel rating (Stage 2/3): **скориговано емпірично (2026-09-10)** — неавторизований fetch (Stage 2) дає надійний **onsite/offsite** поділ (`data-tracking-control-name`, 10 вакансій) і надійну детекцію **rating 4** (`message-the-recruiter` блок, 1 приклад — `jobs/view/4458957079`). Не дає: 0 vs 1, 2 vs 3. Відкриті питання звужуються до двох: (а) чи достатньо грубого onsite/offsite поділу для `--channel`-фільтра в більшості випадків, чи користувачу принципово потрібна точність 0 vs 1 / 2 vs 3 (і тоді browser-крок для них неминучий); (б) чи rating 4 — справді 5-та точка на тій самій шкалі, чи незалежна ознака «є контакт рекрутера», яка теоретично може співіснувати і з offsite-вакансією — перевірено поки лише на одному onsite-прикладі, потрібен offsite-приклад із `message-the-recruiter`, щоб перевірити, чи це поєднання взагалі трапляється.
- Скільки запитів/яка частота до `SEARCH_URL` (Stage 1) і до окремих вакансій (`url`-запитів Stage 2) вважається «низьким обсягом» (ToS caveat) — конкретне число чи затримка між запитами, не лише загальне «keep volume low». Емпірично (Stage 2): ~7 швидких послідовних запитів без затримки вже викликають soft rate-limit (200 + authwall-редирект тілом), 3с затримки досить, щоб той самий запит пройшов — але точний поріг (скільки саме запитів, чи є плаваюче вікно) не виміряний, і чи `SEARCH_URL` (Stage 1) підпадає під той самий поріг — не перевірено окремо.
- Точний heuristic для детекції soft rate-limit за вмістом відповіді (Stage 2, «Нова знахідка») — розмір тіла (< якогось порогу байт) + пошук підрядка `authwall` досить надійні за одним спостереженим прикладом (792 байти), але не перевірено на різноманітність цієї сторінки (чи вона завжди саме такого розміру/змісту, чи буває інший варіант soft-block).
- Формат/синтаксис `--channel <rating|name>`: чи приймає лише число, лише назву каналу, чи обидва; список канонічних назв (`easy-apply`, `linkedin-apply`, `external-ats`, `company-site`, `meet-the-hiring-team`).
- Точна canonical schema обов'язкових полів для Stage 0 gate — спільна з `onboarding.md` Stage O1 (один список, не два окремих).
- Точний інтерфейс/флаги команди `onboard` (див. `onboarding.md`), і як саме `apply` формулює повідомлення користувачу при незданому gate (просто назва команди, чи одразу перелік конкретних полів, яких бракує).
- `url` лишається locale-специфічним навіть після query-stripping (`uk.linkedin.com` vs `in.linkedin.com` vs `www.linkedin.com` для однієї й тієї ж вакансії, залежно від регіону пошуку) — теоретично можливий dedup-miss на цьому, якщо той самий job зіскрапити вдруге через інший регіональний пошук. Не вирішується реконструкцією url (навмисне рішення — тримати url «як є»); лишається відкритим, чи потрібна якась легша нормалізація саме піддомену.
