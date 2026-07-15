@echo off
rem Runs the CLI straight from this checkout. %~dp0 is this file's own directory,
rem so the launcher keeps working wherever the repo is cloned, and always runs the
rem current code rather than a copy that has to be re-synced after every change.
node "%~dp0cli\index.js" %*
