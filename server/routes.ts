import type {Express, Request, Response} from "express";
import {createServer, type Server} from "http";
import multer, {FileFilterCallback} from "multer";
import path from "path";
import {Content, ContentRegistration, Thread} from "@db/schema";
import OpenAI from "openai";
import {SYSTEM_PROMPT} from "./constants";
import {authenticateUser, authorizeContentCreator, authorizeSubscriber, createUser, loginUser} from "./auth";
import bcrypt from 'bcrypt';
import {v4 as uuidv4} from 'uuid';

const openai = new OpenAI();

// Extend the Request type to include the user property
declare module 'express' {
  interface Request {
    user?: {
      id: number;
      role: string;
    };
  }
}

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: 'uploads/',
  filename: (req: Request, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: {fileSize: 5 * 1024 * 1024}, // 5MB limit
  fileFilter: (req: Request, file: Express.Multer.File, cb: FileFilterCallback) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif',
      'application/pdf', 'text/plain', 'text/markdown'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

// Password hashing function
const hashPassword = async (password: string): Promise<string> => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};


// Updated ContentCreatorView and SubscriberView to hash passwords
const ContentCreatorView = {
  listContents: [authorizeContentCreator, async (req: Request, res: Response) => {
    try {
      // const creatorContents = await Content.findAll({where: {creatorId: req.user!.id}});
      const creatorContents = await Content.findAll();//todo: fix
      res.json(creatorContents);
    } catch (error) {
      res.status(500).json({error: 'Failed to fetch contents'});
    }
  }],

  listSubscribers: [authorizeContentCreator, async (req: Request, res: Response) => {
    try {
      const contentId = parseInt(req.params.id);
      const contentSubscribers = await ContentRegistration.findAll({where: {contentId}});
      res.json(contentSubscribers);
    } catch (error) {
      res.status(500).json({error: 'Failed to fetch subscribers'});
    }
  }],

  removeSubscriber: [authorizeContentCreator, async (req: Request, res: Response) => {
    try {
      const contentId = parseInt(req.params.contentId);
      const subscriberId = parseInt(req.params.subscriberId);
      await ContentRegistration.destroy({
        where: {
          contentId,
          subscriberId,
        },
      });
      res.json({message: 'Subscriber removed successfully'});
    } catch (error) {
      res.status(500).json({error: 'Failed to remove subscriber'});
    }
  }],
};

const SubscriberView = {
  listSubscriptions: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const subscriberSubscriptions = await ContentRegistration.findAll({where: {subscriberId: req.user!.id}});
      res.json(subscriberSubscriptions);
    } catch (error) {
      res.status(500).json({error: 'Failed to fetch subscriptions'});
    }
  }],
};

const ContentView = {
  create: [authorizeContentCreator, upload.array('files', 5), async (req: Request, res: Response) => {
    try {
      const sharingId = req.body.isPublic ? uuidv4() : null;
      const content = await Content.create({
        creatorId: req.user!.id,
        isPublic: req.body.isPublic,
        sharingId,
      });
      res.json(content);
    } catch (error) {
      res.status(500).json({error: 'Failed to create content'});
    }
  }],

  update: [authorizeContentCreator, async (req: Request, res: Response) => {
    try {
      const contentId = parseInt(req.params.id);
      const [updated] = await Content.update({
        isPublic: req.body.isPublic,
        sharingId: req.body.sharingId,
        ready: req.body.ready,
      }, {
        where: {id: contentId},
      });
      if (updated) {
        const updatedContent = await Content.findByPk(contentId);
        res.json(updatedContent);
      } else {
        res.status(404).json({error: 'Content not found'});
      }
    } catch (error) {
      res.status(500).json({error: 'Failed to update content'});
    }
  }],

  register: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const contentId = parseInt(req.params.id);
      const registration = await ContentRegistration.create({
        subscriberId: req.user!.id,
        contentId,
      });
      res.json(registration);
    } catch (error) {
      res.status(500).json({error: 'Failed to register for content'});
    }
  }],

  unregister: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const contentId = parseInt(req.params.id);
      await ContentRegistration.destroy({
        where: {
          subscriberId: req.user!.id,
          contentId,
        },
      });
      res.json({message: 'Unregistered successfully'});
    } catch (error) {
      res.status(500).json({error: 'Failed to unregister from content'});
    }
  }],
};

const ThreadView = {
  create: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      // Create the thread with the provided data
      // const thread = await Thread.create({
      //   subscriberId: req.user!.id, // Assuming req.user is populated by authentication middleware
      //   contentId: req.body.contentId,
      //   messages: req.body.messages,
      //   metaInfo: req.body.metaInfo,
      // }); //todo:fix

      let assistantResponse = null;

      // Generate completion if requested
      if (req.body.generateCompletion) {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini", // Use the gpt-4o model
          messages: [
            { role: "system", content: SYSTEM_PROMPT }, // System prompt
            ...req.body.messages, // User-provided messages
          ],
        });

        // Save the completion result to the thread
        assistantResponse = completion.choices[0].message.content;
        // await thread.save(); // Persist the updated thread with completion
      }

      // Return the created thread and assistant response
      res.status(201).json({
        // ...thread.dataValues, // Use .dataValues to access attributes
        assistantResponse, // Include the assistant response
      });
    } catch (error) {
      console.error('Error creating thread:', error); // Log the error for debugging
      res.status(500).json({ error: 'Failed to create thread' });
    }
  }],

  update: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const threadId = parseInt(req.params.id);
      const { messages, metaInfo, generateCompletion, append } = req.body;

      // Fetch the existing thread
      const thread = (await Thread.findByPk(threadId))?.dataValues;
      if (!thread) {
        return res.status(404).json({ error: 'Thread not found' });
      }

      // Update messages: append if `append` is true, otherwise replace
      const updatedMessages = append
        ? [...thread.messages, ...messages] // Append new messages to existing ones
        : messages; // Replace existing messages

      // Update the thread
      const [updated] = await Thread.update(
        {
          messages: updatedMessages,
          metaInfo: metaInfo || thread.metaInfo, // Preserve existing metaInfo if not provided
        },
        {
          where: { id: threadId },
        }
      );

      let assistantResponse = null;

      if (updated) {
        const updatedThread = await Thread.findByPk(threadId);

        // Generate completion if requested
        if (generateCompletion) {
          const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini", // Use the gpt-4o model
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              ...updatedMessages, // Use the updated messages
            ],
          });

          // Save the completion result to the thread
          assistantResponse = completion.choices[0].message.content;
        }

        // Return the updated thread and assistant response
        res.json({
          ...updatedThread!.dataValues, // Use .dataValues to access attributes
          assistantResponse, // Include the assistant response
        });
      } else {
        res.status(404).json({ error: 'Thread not found or not updated' });
      }
    } catch (error) {
      console.error('Error updating thread:', error);
      res.status(500).json({ error: 'Failed to update thread' });
    }
  }],

  get: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const threadId = parseInt(req.params.id);
      const thread = await Thread.findByPk(threadId);

      if (req.body.generateCompletion) {
        const completion = await openai.chat.completions.create({
          messages: [{role: "system", content: SYSTEM_PROMPT}, ...thread.messages],
          model: "gpt-4",
        });
        thread.completion = completion.choices[0].message.content;
      }

      res.json(thread);
    } catch (error) {
      res.status(500).json({error: 'Failed to fetch thread'});
    }
  }],

  delete: [authorizeSubscriber, async (req: Request, res: Response) => {
    try {
      const threadId = parseInt(req.params.id);
      await Thread.destroy({where: {id: threadId}});
      res.json({message: 'Thread deleted successfully'});
    } catch (error) {
      res.status(500).json({error: 'Failed to delete thread'});
    }
  }],
};

// Public Courses and Registration
const PublicContentView = {
  list: async (req: Request, res: Response) => {
    try {
      const publicContents = await Content.findAll({where: {isPublic: true}});
      res.json(publicContents);
    } catch (error) {
      res.status(500).json({error: 'Failed to fetch public contents'});
    }
  },
};

// Register routes
export function registerRoutes(app: Express): Server {
  // Authentication middleware
  app.post('/api/login', loginUser)
  app.post('/api/register', createUser)
  app.use('/api/*path', authenticateUser);

  // ContentCreator routes
  app.get('/api/content-creators/contents', ContentCreatorView.listContents);
  app.get('/api/content-creators/contents/:id/subscribers', ContentCreatorView.listSubscribers);
  app.delete('/api/content-creators/contents/:contentId/subscribers/:subscriberId/remove', ContentCreatorView.removeSubscriber);

  // Subscriber routes
  app.get('/api/subscribers/subscriptions', SubscriberView.listSubscriptions);

  // Content routes
  app.post('/api/contents/create', ContentView.create);
  app.put('/api/contents/:id', ContentView.update);
  app.post('/api/contents/:id/register', ContentView.register);
  app.delete('/api/contents/:id/unregister', ContentView.unregister);

  // Thread routes
  app.post('/api/threads/create', ThreadView.create);
  app.put('/api/threads/:id/update', ThreadView.update);
  app.get('/api/threads/:id', ThreadView.get);
  app.delete('/api/threads/:id/delete', ThreadView.delete);

  // Public content routes
  app.get('/api/public-contents', PublicContentView.list);

  const httpServer = createServer(app);
  return httpServer;
}