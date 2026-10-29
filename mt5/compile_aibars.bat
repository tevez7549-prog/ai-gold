@echo off
rem AI-GOLD: copies AIBarsEA.mq5 (real token, VPS only) into the EXNESS terminal and compiles it. Never touches Pepperstone / Mark1.
set T=C:\ForexAgent\MetaTrader 5 IC Markets Global
set DATA=C:\Users\Administrator\AppData\Roaming\MetaQuotes\Terminal\FF8D8E44A531CCB8172561891EDEE0BB
set LOG=C:\ForexAgent\ai-gold\compile_status.txt
echo %date% %time% start > "%LOG%"
copy /Y "C:\ForexAgent\ai-gold\AIBarsEA.mq5" "%DATA%\MQL5\Experts\AIBarsEA.mq5" >> "%LOG%"
"%T%\MetaEditor64.exe" /compile:"%DATA%\MQL5\Experts\AIBarsEA.mq5" /log:"C:\ForexAgent\ai-gold\compile.log"
if exist "%DATA%\MQL5\Experts\AIBarsEA.ex5" (echo EX5 OK >> "%LOG%") else (echo EX5 MISSING >> "%LOG%")
