# PS2 Hybrid — Play! + ⚡ Fast (recomp)

- كل الملفات في جذر واحد. موقعك (Play!) + زر ⚡ Fast يفتح `fast.html`.
- `prep_game.sh` : يحوّل CHD → ISO → يبني اللعبة بـ recomp (على جهازك، Linux/Mac/WSL).
- `fast_touch.js` : أزرار اللمس لوضع Fast (حجم/شفافية/اهتزاز) + تفعيل COOP/COEP تلقائياً.

## الخطوات
1. `git clone` أو فك ضغط ps2-web-recomp، وثبّت: cmake ninja clang python3 chdman.
2. `./prep_game.sh ../ps2-web-recomp-main "Need for Speed - Underground (USA) (Demo).chd" nfsu`
3. جرّب محلياً بالأمر الذي يطبعه السكربت (serve.py).
4. السكربت يضع fast.html و ps2web.* في نفس الجذر؛ ارفع الجذر كله ما عدا `_disc/` وملفات `*.iso`.
5. ملف اللعبة (disc.iso) لا يُرفع إلى GitHub (حد 100MB + حقوق). استضفه عندك مع Range+CORS وافتح: `fast.html?disc=https://.../disc.iso`

ملاحظة: التوافق مع NFS Underground Demo غير مضمون؛ إن توقف ستظهر رسالة `[sys] unhandled syscall` أو `[iop] missing` في السجل.
