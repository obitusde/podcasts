#!/usr/bin/env bash
# Schreibt data/analysis.json und data/config.json ins Repository.
# Wird nach jedem Durchgang aufgerufen, damit die App eine fertige Folge
# sofort bekommt und nicht auf das Ende eines langen Morgenlaufs wartet.
set -e
git add data/analysis.json data/config.json
if git diff --staged --quiet; then
  echo "Keine Änderung."
  exit 0
fi
git commit -q -m "Werbe- und Themen-Analyse aktualisiert"

# Beim Schreiben kann in der Zwischenzeit ein anderer Lauf geschrieben
# haben. Dann gewinnt die eigene, frisch berechnete Fassung (-X theirs
# bezieht sich beim Rebase auf den eigenen Commit). Drei Versuche, danach
# lieber abbrechen als Murks committen.
for versuch in 1 2 3; do
  if git push -q; then
    echo "Gespeichert (Versuch $versuch)."
    exit 0
  fi
  echo "Push fehlgeschlagen - neuer Stand wird geholt."
  git pull -q --rebase -X theirs origin main || git rebase --abort
done
echo "::error::Konnte das Ergebnis nicht speichern."
exit 1
