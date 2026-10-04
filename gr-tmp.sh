source ~/.nvm/nvm.sh >/dev/null
rsync -a --exclude node_modules --exclude .git --exclude web/node_modules --exclude gr-tmp.sh /mnt/c/Users/Administrator/workspace/luke-lab/teams-ai/ /home/diego/teams-ai-live/
cd /home/diego/teams-ai-live
npm ci --no-audit --no-fund >/dev/null 2>&1
TEAMS_AI_GH_OWNER=lukeware70X7 TEAMS_AI_FIXTURE=todo-api ./node_modules/.bin/tsx --no-warnings=ExperimentalWarning scripts/integration/orchestrator.ts > /home/diego/golden-run-1.log 2>&1
echo "EXIT $?" >> /home/diego/golden-run-1.log
tail -40 /home/diego/golden-run-1.log
