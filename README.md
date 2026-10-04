# CustomAgentCompetition

The idea behind this project is to give you a place to experiment with AI agents and learn how different prompts, instructions, models, and agent setups affect how well they perform on the same task.

You give multiple agents the same task and let them attempt it at the same time. Their results can then be compared and scored so you can see how changes to an agent affect its performance.

<img width="1534" height="771" alt="Screenshot from 2026-08-28 14-04-08" src="https://github.com/user-attachments/assets/90f1c874-e144-4764-9675-f03172971ae1" />

The main purpose is to practice prompting. You can create your own agent, change its prompt or instructions, run it against other agents, and see whether the changes actually improve the result.

You can also use different models as part of the comparison. The project supports bringing your own API keys (BYOK), so what you can run depends on the providers and models you have configured. This can include models such as Qwen, OpenAI models, and other providers that you choose to connect.

A key part of the project is that you are not limited to changing just the prompt. The harness used to make the API call can also be edited. This gives you control over how the agent is set up and how the request is made, allowing you to experiment with different ways of giving the model instructions and context.

The project is intended for local use. It is a tool for experimenting with agents, comparing different approaches, and getting a better understanding of what makes an agent perform well on a particular task.

## What you can do

* Create and test your own agents
* Run multiple agents against the same task
* Compare the results from different agents and models
* Change prompts and agent instructions
* Bring your own API keys
* Try different models depending on your configuration
* Modify the harness used for each API call
* Run your own prompting experiments locally
* Score and compare agents based on how they perform

The goal is not to provide a fixed benchmark for deciding which model is best. It is a way to experiment with the setup around a model and see how much difference your own prompting and agent configuration can make.

The project is built with TypeScript and Next.js, with the agent implementations and API configuration kept in the project so they can be changed and experimented with.
