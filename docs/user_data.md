# user_data.md — job_pipeline

Структура та правила заповнення `cv/` (готовий набір CV) і `user_info.md`, плюс наскрізний флоу їх створення/оновлення (хто саме читає/пише кожен файл і коли). Доповнює `onboarding.md` (сам процес збору) і `flow.md` (apply pipeline, що ці файли споживає). Терміни — див. `brief.md#Glossary`.

**Історія (2026-09-24):** до цього тут була структура `base_cv.md` — єдиний профіль з canonical/extended bullet pool, з якого Stage 4 `flow.md` генерував tailored CV під кожну вакансію. Це рішення скасоване — Stage 4 більше нічого не генерує, а обирає один із заздалегідь підготовлених CV у `cv/`. `base_cv.md` як концепція прибраний повністю; `cv/` тепер єдине джерело правди для CV-контенту.

## Lifecycle — хто читає, хто пише

| файл | створює | читає | оновлює |
|---|---|---|---|
| `cv/<track>/cv.md` + PDF | користувач вручну, поза пайплайном (див. Open questions) | `flow.md` Stage 4 (select CV), Stage 3.5 (LLM review) | користувач вручну; пайплайн (`flow.md`/`onboarding.md`) цей контент ніколи не редагує, лише читає |
| `user_info.md` | `onboard` Stage O3 | `flow.md` Stage 0 (gate), Stage 1 (search criteria), Stage 3 (fit), Stage 5 (form-fill) | `onboard` Stage O3 (bulk, з підтвердженням — Stage O4) **і** `flow.md` Stage 6 (point-fix, одразу, без підтвердження, мід-ран) |

`user_info.md` — звичайний markdown у git-репозиторії `job_pipeline` (незалежний репо, див. root `CLAUDE.md`), тож «що саме змінилось за цей run» (потрібно для Stage 8 summary, `flow.md`) — це буквально `git diff` на цей файл між початком і кінцем run, без потреби у ручних таймстемпах чи change-log секціях всередині файлу. `cv/` теж у git, але пайплайн його не пише — diff там лише від ручних правок користувача.

**Ручні правки користувача напряму в файлах — дозволені** (це просто markdown), але мають зберігати структуру секцій нижче: canonical schema (Stage 0 `flow.md` / Stage O1 `onboarding.md`) звіряється по заголовках секцій.

## `cv/` — структура

Готовий, статичний набір CV — по одному на напрямок: `cv/frontend/`, `cv/backend/`, `cv/aws/`, `cv/full_stack/`. Кожна директорія містить `cv.md` (джерело) і вже відрендерений PDF з тим самим контентом — саме PDF прикріплюється в Stage 5 `flow.md`, `cv.md` читається кодом Stage 4 для skill-матчингу.

**Структура `cv.md`** (надихнено форматом `resume_master.md` з `career/job_search`, без залежності від нього — `flow.md`, «Незалежний проект»):

```
## Summary
## Experience
### <Company> — <Title> (<period>, <location/format>)
- bullets (3–5, фіксовані для цього треку — без canonical/extended поділу, тейлорингу нема)
## Skills
## Education
## Projects   (опціонально)
```

**Правила заповнення:**
- `Experience`/`Education` — reverse-chronological (найновіше зверху).
- Кожен bullet — один рядок, result/impact-first (не «робив X», а «зробив X → результат Y», з числом де можливо).
- **`## Skills` — формат рядка: `Категорія: скіл, скіл, скіл`** (напр. `Frontend: React, TypeScript, JavaScript, Gatsby, HTML, CSS`) — один рядок на категорію, перевикористаний з формату `career/job_search` (`resume_master.md`). Потрібен саме цей формат, бо Stage 4 `flow.md` парсить цю секцію в плаский список скілів для перетину зі стеком вакансії — без фіксованого формату нема що парсити програмованим способом.
- **Немає окремої секції Contact.** Контакти — єдине джерело правди в `user_info.md` (див. нижче); шапка кожного `cv.md`/PDF містить контакти буквально (вони не змінюються між вакансіями, тож дублювання тут не створює розбіжностей, на відміну від старої tailored-схеми).
- **A4-обмеження в одну сторінку** застосовується до кожного `cv.md`/PDF безпосередньо, під час ручного укладання — нема окремого enforcement-кроку в пайплайні, бо нема генерації.

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
- Точна директорія, де фізично лежить `user_info.md` у репозиторії `job_pipeline` (корінь репо чи виділена `data/`-подібна тека) — на разі в усіх документах він згадується без шляху. `cv/<track>/` уже зафіксовано.
- Формат `Search criteria`/`Answer bank` усередині секції — вільний текст, таблиця, чи `key: value` список (впливає на те, наскільки легко Stage 6 дописувати нове поле програмно).
- Чи потрібен `Projects` в `cv/<track>/cv.md` обов'язковим полем canonical schema (Stage 0 gate), чи лишається чисто опціональним і не блокує gate.
- Як саме підтримується набір `cv/<track>/` (додавання нового треку, оновлення контенту існуючого) — зараз повністю ручний процес поза пайплайном; чи потрібен для цього окремий крок в `onboarding.md`, чи лишається «просто git-репо, редагуй руками».
