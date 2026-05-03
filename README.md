# Fruit Dryer Control App

Web app for a fruit dryer using Firebase weight telemetry. Users select a fruit, the app calculates target weight from the current Firebase reading, shows live weight graphs, and sends a popup plus sound when the target is reached.

## Repo Layout

```text
backend/          Python HTTP API and telemetry loop
frontend/         Mobile-friendly web UI
data/fruits.json  Fruit drying profiles
server.py         Small launcher
```

## Run

```powershell
python server.py
```

Open on this computer:

```text
http://127.0.0.1:8000
```

The server binds to `0.0.0.0`, so a phone on the same Wi-Fi can open the computer's LAN address:

```text
http://YOUR_COMPUTER_IP:8000
```

Allow the port through Windows Firewall if the phone cannot connect.

## Firebase Connection

The app reads current weight from the configured `FIREBASE_WEIGHT_URL`. When `Start Drying` is clicked, the backend also writes the calculated target weight and active control boolean to Firebase:

```text
/foodDrier/targetWeight
/foodDrier/isActive
/foodDrier/ssr
```

The SSR should stay off until `/foodDrier/isActive` or `/foodDrier/ssr` becomes `true`. Both booleans are set back to `false` when the target weight is reached or Stop Drying is clicked.

To use a custom Firebase path:

```powershell
$env:FIREBASE_WEIGHT_URL="https://YOUR_PROJECT.firebaseio.com/weight.json"
$env:FIREBASE_BASE_URL="https://YOUR_PROJECT.firebaseio.com"
$env:FIREBASE_SECRET="YOUR_DATABASE_SECRET"
$env:FIREBASE_CONTROL_PATH="foodDrier"
python server.py
```

## Drying Logic

When drying starts:

- the current Firebase reading becomes the initial weight
- the fruit profile sets target weight from initial and final moisture values
- the selected estimated time gives the first time-left value
- live weight loss updates the remaining-time estimate

Completion happens when:

```text
current_weight_g <= target_weight_g
```

Target formula:

```text
target_weight = initial_weight * (1 - moist_init) / (1 - moist_final)
```

The browser then shows a popup and plays an alarm sound after the user has tapped `Enable Sound`.
