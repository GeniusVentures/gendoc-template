/**
 * Entry point. Load order: config -> transport -> state -> UI -> search hook.
 * If config is absent/disabled or no transport can work, nothing is installed,
 * so mkdocs.yml can include this module unconditionally.
 */
import { loadAskConfig } from "./config.js";
import { DrawerUI } from "./drawer.js";
import { installMaterialSearchHook } from "./material-search.js";
import { SessionManager } from "./session.js";
import { createTransport } from "./transport.js";

async function main(): Promise<void>
{
  const config = await loadAskConfig();
  if (config === null)
  {
    return;
  }

  const transport = createTransport(config);
  if (transport === null)
  {
    return;
  }

  const sessions = new SessionManager();
  let busy = false;

  const doAsk = async (question: string): Promise<void> =>
  {
    if (busy || question === "")
    {
      return;
    }
    const transcript = sessions.active;
    if (!transcript)
    {
      return;
    }
    busy = true;
    drawer.setBusy(true);

    const history = transcript.history();
    transcript.addUser(question);
    const answerIndex = transcript.beginAssistant();

    try
    {
      for await (const event of transport.ask(question, history))
      {
        if (event.sources !== undefined)
        {
          transcript.setSources(answerIndex, event.sources);
        }
        if (event.thinking !== undefined)
        {
          transcript.appendThinking(answerIndex, event.thinking);
        }
        if (event.text !== undefined)
        {
          transcript.appendText(answerIndex, event.text);
        }
        if (event.done === true)
        {
          break;
        }
      }
    }
    catch (error)
    {
      console.error("[ask-widget]", error);
      transcript.setText(answerIndex, "Sorry — something went wrong. Please try again.");
    }
    finally
    {
      busy = false;
      drawer.setBusy(false);
    }
  };

  const drawer = new DrawerUI(
    config,
    sessions,
    (question) => void doAsk(question),
  );

  const searchTarget = {
    askFromSearch(question: string): void
    {
      drawer.open();
      void doAsk(question);
    },
  };
  installMaterialSearchHook(config.title, searchTarget);

  // Material's `navigation.instant` swaps the page body on internal links,
  // detaching our host and rebuilding the search DOM. Material exposes the
  // document$ observable for exactly this; re-run the DOM-dependent setup on
  // every emission. Both calls are idempotent, and without instant loading
  // the observable is simply absent.
  const materialDocument$ = (window as MaterialWindow).document$;
  materialDocument$?.subscribe(() =>
  {
    drawer.reattach();
    installMaterialSearchHook(config.title, searchTarget);
  });
}

/** Material for MkDocs publishes RxJS observables on window when themed features need them. */
interface MaterialWindow extends Window
{
  document$?: { subscribe(next: () => void): unknown };
}

void main();
