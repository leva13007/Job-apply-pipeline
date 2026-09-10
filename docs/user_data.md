# user_data.md — job_pipeline

Структура та правила заповнення `base_cv.md` і `user_info.md`, плюс наскрізний флоу їх створення/оновлення (хто саме читає/пише кожен файл і коли). Доповнює `onboarding.md` (сам процес збору) і `flow.md` (apply pipeline, що ці файли споживає). Терміни — див. `brief.md#Glossary`.

## Lifecycle — хто читає, хто пише

| файл | створює | читає | оновлює |
|---|---|---|---|
| `base_cv.md` | `onboard` Stage O2 | `flow.md` Stage 3 (match), Stage 4 (generate CV) | тільки `onboard` Stage O2 (повторний виклик під gaps/правки). **Stage 6 `flow.md` цей файл ніколи не чіпає** — mid-run clarification відповідає на анкетні питання, а не редагує CV-контент. |
| `user_info.md` | `onboard` Stage O3 | `flow.md` Stage 0 (gate), Stage 1 (search criteria), Stage 3 (fit), Stage 5 (form-fill) | `onboard` Stage O3 (bulk, з підтвердженням — Stage O4) **і** `flow.md` Stage 6 (point-fix, одразу, без підтвердження, мід-ран) |

Обидва файли — звичайний markdown у git-репозиторії `job_pipeline` (незалежний репо, див. root `CLAUDE.md`), тож «що саме змінилось за цей run» (потрібно для Stage 8 summary, `flow.md`) — це буквально `git diff` на ці два файли між початком і кінцем run, без потреби у ручних таймстемпах чи change-log секціях всередині файлів.

**Ручні правки користувача напряму в файлах — дозволені** (це просто markdown), але мають зберігати структуру секцій нижче: canonical schema (Stage 0 `flow.md` / Stage O1 `onboarding.md`) звіряється по заголовках секцій.

## `base_cv.md` — структура

Надихнено форматом `resume_master.md` з `career/job_search`, без залежності від нього (`flow.md`, «Незалежний проект»).

```
## Summary
## Experience
### <Company> — <Title> (<period>, <location/format>)
- canonical bullets (3–5, ті що йдуть у базовий/канонічний CV за замовчуванням)
#### Extended pool
- додаткові bullets, кандидати на заміну під конкретну вакансію (Stage 3/4 `flow.md`)
## Skills
## Education
## Projects   (опціонально)
```

**Правила заповнення:**
- `Experience`/`Education` — reverse-chronological (найновіше зверху).
- Кожен bullet — один рядок, result/impact-first (не «робив X», а «зробив X → результат Y», з числом де можливо).
- **Canonical vs extended pool** — це не «головне vs другорядне» в сенсі якості, а «дефолтний набір» vs «додатковий резерв для tailoring»: Stage 3/4 `flow.md` можуть підмінити canonical bullet на bullet з extended pool, якщо він краще matчить конкретну вакансію.
- **Немає окремої секції Contact.** Контакти — єдине джерело правди в `user_info.md` (див. нижче); Stage 4 `flow.md` бере контактний блок звідти напряму при рендері CV. Це навмисно — у job_search skill контакти дублювались (`resume_master.md` + `content.js`) і розходились одне з одним; тут дублювання просто виключене структурно.
- **A4-обмеження в одну сторінку (з `brief.md`) стосується згенерованого tailored CV (Stage 4 `flow.md`), не `base_cv.md`.** `base_cv.md` — це надмножина/content pool (включно з extended bullet pool), може бути довшим за сторінку; на одну сторінку стискається вже відібраний під конкретну вакансію контент.

## `user_info.md` — структура

```
## Contact
name / email / phone / location / LinkedIn / GitHub-portfolio

## Search criteria
посада(и) / стек (must-have vs nice-to-have) / seniority / локація-remote / зарплата (мін./ціль)

## Constraints
confidentiality (видимість пошуку від поточного роботодавця) / excluded companies-industries (якщо є)

## Answer bank
стандартні анкетні відповіді: notice period, salary expectation, короткий right-to-work статус (не sensitive-деталі — ті нижче), і т.д.

## Sensitive answers (EEO / demographic)
DOB, детальний visa/right-to-work статус, стать/орієнтація, етнічність, релігія, інвалідність, поточна зарплата
```

**Правила заповнення:**
- `Search criteria` — це те, чим користується Stage 1 `flow.md` (`search criteria / filter profile`, glossary) і Stage 3 (fit). Стек варто ділити на must-have/nice-to-have — саме це розмежування Stage 3 використовує для «що важливе, що допоміжне».
- `Answer bank` і `Sensitive answers` — окремі секції навмисно, не одна «FAQ»-секція. `Sensitive answers` — фіксований, впізнаваний заголовок: будь-який процес, що читає файл (Stage 5 form-fill, Stage 6 clarification write, Stage 8 summary), розпізнає цю секцію і застосовує **sensitivity rule**: значення звідси йдуть лише в буквальне поле форми (Stage 5), ніколи не переказуються/цитуються деінде — ні в chat, ні в tracker `applications.csv`, ні в known-issues документі, ні в Stage 8 summary (сам факт «щось у Sensitive answers оновлено» можна згадати, вміст — ні).
- Нове поле від Stage 6 (мід-ран) дописується в ту секцію, до якої воно належить за змістом (найчастіше `Answer bank`, іноді `Sensitive answers` якщо форма змусила) — не в окремий «журнал змінень» (для цього є `git diff`, див. Lifecycle вище).

## Open questions / TBD
- Точна директорія, де фізично лежать `base_cv.md`/`user_info.md` у репозиторії `job_pipeline` (корінь репо чи виділена `data/`-подібна тека) — на разі в усіх документах вони згадуються без шляху.
- Формат `Search criteria`/`Answer bank` усередині секції — вільний текст, таблиця, чи `key: value` список (впливає на те, наскільки легко Stage 6 дописувати нове поле програмно).
- Чи потрібен `Projects` в `base_cv.md` обов'язковим полем canonical schema (Stage 0 gate), чи лишається чисто опціональним і не блокує gate.
