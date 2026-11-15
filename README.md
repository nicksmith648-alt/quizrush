# QuizRush

An original classroom quiz game (not affiliated with Kahoot). Teacher hosts on the projector, students join from phones with a PIN.

## Run it
```
npm install     # once
npm start       # prints the teacher URL and the student URL
```
- **Teacher (projector):** open `http://localhost:3000/host`
- **Students:** open the `http://<your-ip>:3000` address printed in the terminal (same Wi-Fi as the teacher laptop), enter the PIN and a nickname. Opening `/?pin=123456` pre-fills the PIN, so you can show it as a QR code or link.

Change the port with `PORT=8080 npm start`.

## Make quizzes
Drop a `.txt` file in `quizzes/` (it shows in the host dropdown), or paste into the box on the host page.

```
# Quiz title

Question text?
time: 20          (optional, seconds, 5-120, default 20)
*correct answer   (start the correct one with *)
wrong answer
wrong answer
wrong answer      (2 to 4 answers per question)

Next question...
```
JSON also works: `{"title":"..","questions":[{"q":"..","options":["a","b"],"correct":0,"time":20}]}`

## Game modes
On the host page choose a mode before starting:
- **Classic race:** everyone answers the same question together; faster = more points.
- **Code Breaker:** everyone plays at their own pace for 3-15 minutes. A correct answer earns coins (100, +20 per answer in a row, up to +100). Then you try to **crack a random rival's 4-digit vault code**: pick 1 of 3 codes and, if it's theirs, you steal 25% of their coins (at least 50). A rival's real code stays the same until someone cracks it, so players who notice which code keeps coming back can crack them reliably. The host sees a live leaderboard and feed, and can end the game early.

## How Classic plays
1. Host picks a quiz, gets a 6-digit PIN, students join, host presses Start.
2. Each question shows on the big screen; students tap their answer on their phone.
3. Score = up to 1000 for a correct answer (faster = more), plus a streak bonus (+100 per consecutive correct answer, max +500).
4. After each question: correct answer, how many chose each option, top 5. At the end: podium.
5. The question ends early when everyone has answered; **Skip timer** ends it manually. The ✕ next to a name in the lobby removes a student.
6. A student who loses connection can rejoin with the same nickname and keep their score.

## Notes
- Everything is in memory on the teacher's laptop. Nothing is saved, no accounts, no data leaves your network.
- Tell students to use a first name or a nickname.
- Tests: start the server with `PORT=3055 npm start`, then `node test/sim.mjs`.

## Put it on the internet (so students just open a link)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/nicksmith648-alt/quizrush)

1. Click the button above and sign in to Render with GitHub. Render reads `render.yaml` and asks for `HOST_PASSWORD` (the teacher password).
3. When it finishes you get an address like `https://quizrush-xxxx.onrender.com`. Students open it; you open `/host` on the same address and enter the password.

The free plan sleeps after ~15 minutes idle (first visit then takes about a minute), so open the site before class. Games live in memory and are lost on restart. To run the teacher-password check locally: `HOST_PASSWORD=secret npm start`.
